import type {
	ChatTransport,
	UIMessage,
	UIMessageChunk,
	ChatRequestOptions,
} from "ai";
import type { SessionDB } from "../collection";
import type { ChunkRow } from "../schema";

export interface DurableChatTransportOptions {
	proxyUrl: string;
	sessionId: string;
	authToken?: string;
	sessionDB: SessionDB;
}

export class DurableChatTransport implements ChatTransport<UIMessage> {
	private readonly proxyUrl: string;
	private readonly sessionId: string;
	private readonly authToken?: string;
	private readonly sessionDB: SessionDB;

	constructor(options: DurableChatTransportOptions) {
		this.proxyUrl = options.proxyUrl;
		this.sessionId = options.sessionId;
		this.authToken = options.authToken;
		this.sessionDB = options.sessionDB;
	}

	private get headers(): Record<string, string> {
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (this.authToken) h.Authorization = `Bearer ${this.authToken}`;
		return h;
	}

	private url(path: string): string {
		return `${this.proxyUrl}/v1/sessions/${this.sessionId}${path}`;
	}

	sendMessages = async (
		options: {
			trigger: "submit-message" | "regenerate-message";
			chatId: string;
			messageId: string | undefined;
			messages: UIMessage[];
			abortSignal: AbortSignal | undefined;
		} & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk>> => {
		const { messages, abortSignal } = options;
		const lastMessage = messages[messages.length - 1];

		// Detect what to send based on the last message
		if (lastMessage?.role === "user") {
			// Extract text content from user message parts
			const textPart = lastMessage.parts.find((p) => p.type === "text");
			const content = textPart
				? (textPart as { type: "text"; text: string }).text
				: "";

			// POST user message to proxy
			await fetch(this.url("/messages"), {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify({
					content,
					messageId: lastMessage.id,
				}),
				signal: abortSignal,
			});
		}

		// TODO: Handle tool output and approval cases by inspecting messages
		// for unsent tool results / approval responses

		// Subscribe to sessionDB.collections.chunks for new entries
		// and convert them to UIMessageChunk stream
		return this.createChunkStream(abortSignal);
	};

	reconnectToStream = async (
		options: {
			chatId: string;
		} & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk> | null> => {
		// SessionDB already has cached data from TanStack DB
		// Check if there's an active generation by looking at chunks
		// that don't have a terminal chunk yet
		// For now, subscribe to ongoing changes
		return this.createChunkStream(undefined);
	};

	private createChunkStream(
		abortSignal: AbortSignal | undefined,
	): ReadableStream<UIMessageChunk> {
		const chunks = this.sessionDB.collections.chunks;
		const seenKeys = new Set<string>();

		// Track all currently known chunk keys so we only emit new ones
		for (const row of chunks.values()) {
			seenKeys.add((row as ChunkRow).id);
		}

		return new ReadableStream<UIMessageChunk>({
			start: (controller) => {
				// Watch for new chunk entries via subscribeChanges
				const subscription = chunks.subscribeChanges((changes) => {
					for (const change of changes) {
						if (change.type === "insert" || change.type === "update") {
							const row = change.value as ChunkRow;
							if (seenKeys.has(row.id)) continue;
							seenKeys.add(row.id);

							try {
								const parsed = JSON.parse(row.chunk);

								if (parsed.type === "whole-message") {
									// Convert whole message to UIMessageChunk sequence
									const msg = parsed.message;
									for (const part of msg.parts ?? []) {
										if (part.type === "text") {
											const id = crypto.randomUUID();
											controller.enqueue({
												type: "text-start",
												id,
											} as UIMessageChunk);
											controller.enqueue({
												type: "text-delta",
												id,
												delta: part.text,
											} as UIMessageChunk);
											controller.enqueue({
												type: "text-end",
												id,
											} as UIMessageChunk);
										}
									}
								} else {
									// Already a UIMessageChunk — enqueue directly
									controller.enqueue(parsed as UIMessageChunk);
								}
							} catch {
								// Skip unparseable chunks
							}
						}
					}
				});

				// Cleanup on abort
				abortSignal?.addEventListener("abort", () => {
					subscription.unsubscribe();
					controller.close();
				});
			},
		});
	}
}
