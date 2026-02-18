/**
 * Self-contained chat hook that owns the entire session lifecycle.
 *
 * Clients just pass sessionId + auth config. Internally this hook:
 * 1. Creates and manages the SessionDB
 * 2. Handles preload → ready state
 * 3. Subscribes to the messages collection via useSyncExternalStore
 * 4. Exposes metadata (title, config, presence) via embedded useChatMetadata
 * 5. Provides sendMessage / stop actions as simple POSTs
 */

import { createOptimisticAction } from "@durable-streams/state";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSessionDB } from "../collection";
import type { ChunkRow } from "../schema";
import { createMessagesCollection } from "../collections/messages";
import { messageRowToUIMessage } from "../materialize";
import { type UseChatMetadataReturn, useChatMetadata } from "./useChatMetadata";
import { useCollectionData } from "./useCollectionData";

export interface UseDurableChatOptions {
	sessionId: string;
	proxyUrl: string;
	getHeaders?: () => Record<string, string>;
}

export interface UseDurableChatReturn {
	ready: boolean;
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
	metadata: UseChatMetadataReturn;
}

export function useDurableChat(
	options: UseDurableChatOptions,
): UseDurableChatReturn {
	const { sessionId, proxyUrl, getHeaders } = options;

	// --- SessionDB lifecycle ---
	const sessionDB = useMemo(
		() =>
			createSessionDB({
				sessionId,
				baseUrl: `${proxyUrl}/api/streams`,
				headers: getHeaders?.(),
			}),
		[sessionId, proxyUrl],
	);

	const [ready, setReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		sessionDB
			.preload()
			.then(() => {
				if (!cancelled) setReady(true);
			})
			.catch((err) =>
				console.error("[useDurableChat] preload failed:", err),
			);
		return () => {
			cancelled = true;
			setReady(false);
			sessionDB.close();
		};
	}, [sessionDB]);

	// --- URL + headers helpers ---
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

	const isLoading = useMemo(
		() => rows.some((row) => !row.isComplete),
		[rows],
	);

	// --- Metadata (title, config, presence, agents) ---
	const metadata = useChatMetadata({
		sessionDB,
		proxyUrl,
		sessionId,
		getHeaders,
	});

	// --- Error state ---
	const [error, setError] = useState<string | null>(null);

	// --- Optimistic sendMessage action ---
	// Stable ref to avoid recreating the optimistic action on every render.
	const depsRef = useRef({ url, headers, sessionDB, setError });
	depsRef.current = { url, headers, sessionDB, setError };

	const optimisticSend = useMemo(
		() =>
			createOptimisticAction<{
				text: string;
				messageId: string;
				txid: string;
			}>({
				onMutate: ({ text, messageId }) => {
					const now = new Date().toISOString();
					const chunk: ChunkRow = {
						id: `${messageId}:0`,
						messageId,
						actorId: "user",
						role: "user",
						chunk: JSON.stringify({
							type: "whole-message",
							message: {
								id: messageId,
								role: "user",
								parts: [{ type: "text", text }],
								createdAt: now,
							},
						}),
						seq: 0,
						createdAt: now,
					};
					depsRef.current.sessionDB.collections.chunks.insert(chunk);
				},
				mutationFn: async ({ text, messageId, txid }) => {
					const { url, headers, sessionDB } = depsRef.current;
					const res = await fetch(url("/messages"), {
						method: "POST",
						headers: headers(),
						body: JSON.stringify({
							content: text,
							messageId,
							txid,
						}),
					});
					if (!res.ok) {
						throw new Error(`Failed to send message: ${res.status}`);
					}
					// Wait for the write to sync back through SSE
					await sessionDB.utils.awaitTxId(txid, 10_000);
				},
			}),
		[],
	);

	const sendMessage = useCallback(
		async (text: string) => {
			setError(null);
			const messageId = crypto.randomUUID();
			const txid = crypto.randomUUID();
			try {
				const tx = optimisticSend({ text, messageId, txid });
				await tx.isPersisted.promise;
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to send message",
				);
			}
		},
		[optimisticSend],
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
		ready,
		messages,
		isLoading,
		sendMessage,
		stop,
		submitToolResult,
		submitApproval,
		error,
		metadata,
	};
}
