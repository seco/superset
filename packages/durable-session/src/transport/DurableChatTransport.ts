import type {
	ChatRequestOptions,
	ChatTransport,
	UIMessage,
	UIMessageChunk,
} from "ai";
import type { SessionDB } from "../collection";
import type { ChunkRow } from "../schema";

/** Chunk types that are NOT AI SDK UIMessageChunks — skip these in the stream. */
const NON_CONTENT_TYPES = new Set([
	"whole-message",
	"config",
	"control",
	"tool-result",
	"approval-response",
	"tool-approval",
]);

export interface DurableChatTransportOptions {
	proxyUrl: string;
	sessionId: string;
	sessionDB: SessionDB;
	getHeaders?: () => Record<string, string>;
}

export class DurableChatTransport implements ChatTransport<UIMessage> {
	private readonly proxyUrl: string;
	private readonly sessionId: string;
	private readonly sessionDB: SessionDB;
	private readonly getHeaders: () => Record<string, string>;

	constructor(options: DurableChatTransportOptions) {
		this.proxyUrl = options.proxyUrl;
		this.sessionId = options.sessionId;
		this.sessionDB = options.sessionDB;
		this.getHeaders = options.getHeaders ?? (() => ({}));
	}

	private url(path: string): string {
		return `${this.proxyUrl}/api/streams/v1/sessions/${this.sessionId}${path}`;
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
		const { trigger, messages, abortSignal } = options;

		// Snapshot seenKeys BEFORE the POST so that any response chunks
		// that arrive while the POST is in-flight are treated as new.
		const seenKeys = this.snapshotSeenKeys();

		if (trigger === "submit-message") {
			const lastMessage = messages[messages.length - 1];
			if (lastMessage?.role === "user") {
				const textPart = lastMessage.parts.find((p) => p.type === "text");
				const content = textPart
					? (textPart as { type: "text"; text: string }).text
					: "";

				await fetch(this.url("/messages"), {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...this.getHeaders(),
					},
					body: JSON.stringify({ content, messageId: lastMessage.id }),
					signal: abortSignal,
				});
			}
		} else if (trigger === "regenerate-message") {
			await fetch(this.url("/control"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...this.getHeaders(),
				},
				body: JSON.stringify({ action: "regenerate" }),
				signal: abortSignal,
			});
		}

		return this.createChunkStream(abortSignal, seenKeys);
	};

	reconnectToStream = async (
		_options: { chatId: string } & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk> | null> => {
		const chunks = this.sessionDB.collections.chunks;

		// Scan for incomplete assistant messages and pending user messages
		const finished = new Set<string>();
		const assistantMessageIds = new Set<string>();
		let latestUserTime = "";
		let latestAssistantTime = "";

		for (const row of chunks.values()) {
			const r = row as ChunkRow;
			if (r.role === "user" && r.createdAt > latestUserTime) {
				latestUserTime = r.createdAt;
			}
			if (r.role === "assistant") {
				assistantMessageIds.add(r.messageId);
				if (r.createdAt > latestAssistantTime) {
					latestAssistantTime = r.createdAt;
				}
				try {
					const parsed = JSON.parse(r.chunk);
					if (parsed.type === "finish" || parsed.type === "abort")
						finished.add(r.messageId);
				} catch {}
			}
		}

		// Case 1: Incomplete assistant message → replay existing + forward new
		const incompleteId = [...assistantMessageIds].find(
			(id) => !finished.has(id),
		);
		if (incompleteId) {
			const existingRows: ChunkRow[] = [];
			const seenKeys = new Set<string>();
			for (const row of chunks.values()) {
				const r = row as ChunkRow;
				if (r.messageId !== incompleteId) continue;
				existingRows.push(r);
				seenKeys.add(r.id);
			}
			existingRows.sort((a, b) => a.seq - b.seq);

			return new ReadableStream<UIMessageChunk>({
				start: (controller) => {
					// Replay existing chunks
					for (const row of existingRows) {
						try {
							const parsed = JSON.parse(row.chunk);
							const type = parsed.type as string;
							if (NON_CONTENT_TYPES.has(type)) continue;

							controller.enqueue(parsed as UIMessageChunk);

							if (type === "finish" || type === "abort") {
								controller.close();
								return;
							}
						} catch {}
					}

					// Forward new chunks as they arrive
					const subscription = chunks.subscribeChanges((changes) => {
						for (const change of changes) {
							if (change.type !== "insert" && change.type !== "update")
								continue;
							const row = change.value as ChunkRow;

							if (row.messageId !== incompleteId) continue;
							if (seenKeys.has(row.id)) continue;
							seenKeys.add(row.id);

							try {
								const parsed = JSON.parse(row.chunk);
								const type = parsed.type as string;
								if (NON_CONTENT_TYPES.has(type)) continue;

								controller.enqueue(parsed as UIMessageChunk);

								if (type === "finish" || type === "abort") {
									subscription.unsubscribe();
									controller.close();
								}
							} catch {}
						}
					});
				},
			});
		}

		// Case 2: User message newer than any assistant response → response
		// expected but not started yet (e.g. first message, agent still booting).
		// Return a stream that waits for the response chunks to arrive.
		if (latestUserTime && latestUserTime > latestAssistantTime) {
			return this.createChunkStream(undefined);
		}

		// Case 3: Fully caught up
		return null;
	};

	async submitToolResult(
		toolCallId: string,
		output: unknown,
		error?: string,
	): Promise<void> {
		await fetch(this.url("/tool-results"), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.getHeaders() },
			body: JSON.stringify({ toolCallId, output, error: error ?? null }),
		});
	}

	async submitApproval(
		approvalId: string,
		approved: boolean,
	): Promise<void> {
		await fetch(this.url(`/approvals/${approvalId}`), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.getHeaders() },
			body: JSON.stringify({ approved }),
		});
	}

	/**
	 * Send a control event to the durable stream (e.g. abort the agent).
	 * Called automatically when the user stops a streaming response.
	 */
	private sendControl(action: string): void {
		fetch(this.url("/control"), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.getHeaders() },
			body: JSON.stringify({ action }),
		}).catch(console.error);
	}

	private snapshotSeenKeys(): Set<string> {
		const seenKeys = new Set<string>();
		for (const row of this.sessionDB.collections.chunks.values()) {
			seenKeys.add((row as ChunkRow).id);
		}
		return seenKeys;
	}

	private createChunkStream(
		abortSignal: AbortSignal | undefined,
		seenKeys?: Set<string>,
	): ReadableStream<UIMessageChunk> {
		const chunks = this.sessionDB.collections.chunks;
		const keys = seenKeys ?? this.snapshotSeenKeys();

		return new ReadableStream<UIMessageChunk>({
			start: (controller) => {
				let closed = false;

				// Subscribe FIRST so we don't miss any future chunks
				const subscription = chunks.subscribeChanges((changes) => {
					if (closed) return;
					for (const change of changes) {
						if (change.type !== "insert" && change.type !== "update") continue;
						const row = change.value as ChunkRow;
						if (keys.has(row.id)) continue;
						keys.add(row.id);

						try {
							const parsed = JSON.parse(row.chunk);
							const type = parsed.type as string;

							if (NON_CONTENT_TYPES.has(type)) continue;

							controller.enqueue(parsed as UIMessageChunk);

							if (type === "finish" || type === "abort") {
								closed = true;
								subscription.unsubscribe();
								controller.close();
								return;
							}
						} catch {
							// skip unparseable chunks
						}
					}
				});

				// Gap scan: forward chunks that arrived between seenKeys snapshot
				// and subscription setup (e.g. during the await fetch POST).
				// JS is single-threaded so subscription callbacks won't fire
				// until we return from start(), making this scan safe.
				const gapChunks: ChunkRow[] = [];
				for (const row of chunks.values()) {
					const r = row as ChunkRow;
					if (keys.has(r.id)) continue;
					keys.add(r.id);
					gapChunks.push(r);
				}

				if (gapChunks.length > 0) {
					gapChunks.sort((a, b) => {
						const t = a.createdAt.localeCompare(b.createdAt);
						return t !== 0 ? t : a.seq - b.seq;
					});
					for (const row of gapChunks) {
						if (closed) break;
						try {
							const parsed = JSON.parse(row.chunk);
							const type = parsed.type as string;
							if (NON_CONTENT_TYPES.has(type)) continue;

							controller.enqueue(parsed as UIMessageChunk);

							if (type === "finish" || type === "abort") {
								closed = true;
								subscription.unsubscribe();
								controller.close();
								break;
							}
						} catch {}
					}
				}

				abortSignal?.addEventListener("abort", () => {
					if (closed) return;
					closed = true;
					subscription.unsubscribe();
					controller.close();
					this.sendControl("abort");
				});
			},
		});
	}
}
