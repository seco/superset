/**
 * Collection-based chat hook that replaces DurableChatTransport.
 *
 * Instead of bridging collections → ReadableStream → useChat, this hook
 * subscribes directly to the messages collection via useSyncExternalStore.
 * Actions (send/stop) are simple POSTs.
 */

import type { UIMessage } from "ai";
import { useCallback, useMemo, useState } from "react";
import type { SessionDB } from "../collection";
import { createMessagesCollection } from "../collections/messages";
import { messageRowToUIMessage } from "../materialize";
import { useCollectionData } from "./useCollectionData";

export interface UseDurableChatOptions {
	sessionDB: SessionDB;
	proxyUrl: string;
	sessionId: string;
	getHeaders?: () => Record<string, string>;
}

export interface UseDurableChatReturn {
	messages: (UIMessage & { actorId: string; createdAt: Date })[];
	isLoading: boolean;
	sendMessage: (text: string) => Promise<void>;
	stop: () => void;
	submitToolResult: (
		toolCallId: string,
		output: unknown,
		error?: string,
	) => Promise<void>;
	submitApproval: (approvalId: string, approved: boolean) => Promise<void>;
	error: string | null;
}

export function useDurableChat(
	options: UseDurableChatOptions,
): UseDurableChatReturn {
	const { sessionDB, proxyUrl, sessionId, getHeaders } = options;
	const headers = useCallback(
		() => ({
			"Content-Type": "application/json",
			...(getHeaders?.() ?? {}),
		}),
		[getHeaders],
	);

	const url = useCallback(
		(path: string) =>
			`${proxyUrl}/api/streams/v1/sessions/${sessionId}${path}`,
		[proxyUrl, sessionId],
	);

	// --- Messages via collection pipeline ---
	const messagesCollection = useMemo(
		() =>
			createMessagesCollection({
				chunksCollection: sessionDB.collections.chunks,
			}),
		[sessionDB],
	);

	const rows = useCollectionData(messagesCollection);

	const messages = useMemo(() => rows.map(messageRowToUIMessage), [rows]);

	// isLoading: true when any assistant message is still incomplete
	const isLoading = useMemo(
		() => rows.some((row) => !row.isComplete),
		[rows],
	);

	// --- Error state ---
	const [error, setError] = useState<string | null>(null);

	// --- Actions ---
	const sendMessage = useCallback(
		async (text: string) => {
			setError(null);
			try {
				const res = await fetch(url("/messages"), {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({ content: text }),
				});
				if (!res.ok) {
					setError(`Failed to send message: ${res.status}`);
				}
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to send message",
				);
			}
		},
		[url, headers],
	);

	const stop = useCallback(() => {
		fetch(url("/control"), {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ action: "abort" }),
		}).catch(console.error);
	}, [url, headers]);

	const submitToolResult = useCallback(
		async (toolCallId: string, output: unknown, err?: string) => {
			setError(null);
			try {
				const res = await fetch(url("/tool-results"), {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						toolCallId,
						output,
						error: err ?? null,
					}),
				});
				if (!res.ok) {
					setError(`Failed to submit tool result: ${res.status}`);
				}
			} catch (e) {
				setError(
					e instanceof Error ? e.message : "Failed to submit tool result",
				);
			}
		},
		[url, headers],
	);

	const submitApproval = useCallback(
		async (approvalId: string, approved: boolean) => {
			setError(null);
			try {
				const res = await fetch(url(`/approvals/${approvalId}`), {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({ approved }),
				});
				if (!res.ok) {
					setError(`Failed to submit approval: ${res.status}`);
				}
			} catch (e) {
				setError(
					e instanceof Error ? e.message : "Failed to submit approval",
				);
			}
		},
		[url, headers],
	);

	return {
		messages,
		isLoading,
		sendMessage,
		stop,
		submitToolResult,
		submitApproval,
		error,
	};
}
