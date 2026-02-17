import { useSyncExternalStore, useCallback } from "react";
import type { SessionDB } from "../collection";
import type { RawPresenceRow, AgentRow } from "../schema";

export interface ChatUserPresence {
	userId: string;
	deviceId: string;
	name?: string;
	status: "active" | "idle" | "typing" | "offline";
	draft?: string;
	cursorPosition?: number;
}

export interface ChatAgentPresence {
	agentId: string;
	name?: string;
	endpoint: string;
	model?: string;
	generationMessageId?: string;
	triggers?: "all" | "user-messages";
}

export interface UseChatPresenceOptions {
	sessionDB: SessionDB;
	proxyUrl?: string;
	sessionId?: string;
	authToken?: string;
}

export interface UseChatPresenceReturn {
	users: ChatUserPresence[];
	agents: ChatAgentPresence[];
	updateStatus: (
		userId: string,
		deviceId: string,
		status: ChatUserPresence["status"],
	) => void;
	updateDraft: (
		userId: string,
		deviceId: string,
		text: string,
		cursorPosition?: number,
	) => void;
	drafts: Array<{ userId: string; name?: string; text: string }>;
}

export function useChatPresence(
	options: UseChatPresenceOptions,
): UseChatPresenceReturn {
	const { sessionDB, proxyUrl, sessionId, authToken } = options;

	// Subscribe to presence collection via subscribeChanges
	const subscribeToPresence = useCallback(
		(callback: () => void) => {
			const subscription = sessionDB.collections.presence.subscribeChanges(
				() => {
					callback();
				},
			);
			return () => subscription.unsubscribe();
		},
		[sessionDB],
	);

	const getPresenceSnapshot = useCallback((): ChatUserPresence[] => {
		const rows = Array.from(
			sessionDB.collections.presence.values(),
		) as RawPresenceRow[];
		return rows
			.filter((r) => r.status !== "offline")
			.map((r) => ({
				userId: r.userId,
				deviceId: r.deviceId,
				name: r.name,
				status: r.status,
				draft: r.draft,
				cursorPosition: r.cursorPosition,
			}));
	}, [sessionDB]);

	// Subscribe to agents collection via subscribeChanges
	const subscribeToAgents = useCallback(
		(callback: () => void) => {
			const subscription = sessionDB.collections.agents.subscribeChanges(
				() => {
					callback();
				},
			);
			return () => subscription.unsubscribe();
		},
		[sessionDB],
	);

	const getAgentsSnapshot = useCallback((): ChatAgentPresence[] => {
		const rows = Array.from(
			sessionDB.collections.agents.values(),
		) as AgentRow[];
		return rows.map((r) => ({
			agentId: r.agentId,
			name: r.name,
			endpoint: r.endpoint,
			model: r.model,
			generationMessageId: r.generationMessageId,
			triggers: r.triggers,
		}));
	}, [sessionDB]);

	const users = useSyncExternalStore(
		subscribeToPresence,
		getPresenceSnapshot,
		() => [],
	);
	const agents = useSyncExternalStore(
		subscribeToAgents,
		getAgentsSnapshot,
		() => [],
	);

	const updateStatus = useCallback(
		(
			userId: string,
			deviceId: string,
			status: ChatUserPresence["status"],
		) => {
			if (!proxyUrl || !sessionId) return;
			const endpoint = status === "offline" ? "logout" : "login";
			fetch(`${proxyUrl}/v1/sessions/${sessionId}/${endpoint}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
				},
				body: JSON.stringify({ userId, deviceId, status }),
			}).catch(console.error);
		},
		[proxyUrl, sessionId, authToken],
	);

	const updateDraft = useCallback(
		(
			userId: string,
			deviceId: string,
			text: string,
			cursorPosition?: number,
		) => {
			if (!proxyUrl || !sessionId) return;
			fetch(`${proxyUrl}/v1/sessions/${sessionId}/login`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
				},
				body: JSON.stringify({
					userId,
					deviceId,
					status: "typing",
					draft: text,
					cursorPosition,
				}),
			}).catch(console.error);
		},
		[proxyUrl, sessionId, authToken],
	);

	const drafts = users
		.filter((u) => u.draft && u.draft.length > 0)
		.map((u) => ({ userId: u.userId, name: u.name, text: u.draft! }));

	return { users, agents, updateStatus, updateDraft, drafts };
}
