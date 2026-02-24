import { createAnthropic } from "@ai-sdk/anthropic";
import { getAnthropicAuthToken } from "@superset/agent";
import { generateObject } from "ai";
import { z } from "zod";
import type { GetHeaders } from "../lib/auth/auth";
import { AgentManager, type AgentManagerConfig } from "./agent-manager";

export type ChatLifecycleEventType = "Start" | "PermissionRequest" | "Stop";

export interface ChatLifecycleEvent {
	sessionId: string;
	eventType: ChatLifecycleEventType;
}

const titleSchema = z.object({
	title: z
		.string()
		.describe(
			"A concise 2-5 word title for a coding chat session. Examples: 'Fix Auth Middleware', 'Drizzle Schema Migration', 'React State Refactor', 'WebSocket Setup'",
		),
});

export interface ChatServiceHostConfig {
	deviceId: string;
	apiUrl: string;
	getHeaders: GetHeaders;
	onLifecycleEvent?: (event: ChatLifecycleEvent) => void;
}

export class ChatService {
	private agentManager: AgentManager | null = null;
	private hostConfig: ChatServiceHostConfig;

	constructor(hostConfig: ChatServiceHostConfig) {
		this.hostConfig = hostConfig;
	}

	async start(options: { organizationId: string }): Promise<void> {
		const config: AgentManagerConfig = {
			deviceId: this.hostConfig.deviceId,
			organizationId: options.organizationId,
			apiUrl: this.hostConfig.apiUrl,
			getHeaders: this.hostConfig.getHeaders,
			onLifecycleEvent: (event) => {
				this.hostConfig.onLifecycleEvent?.(event);
				if (event.eventType === "Stop") {
					void this.maybeGenerateTitle(event.sessionId);
				}
			},
		};

		if (this.agentManager) {
			await this.agentManager.restart({
				organizationId: options.organizationId,
				deviceId: this.hostConfig.deviceId,
			});
		} else {
			this.agentManager = new AgentManager(config);
			await this.agentManager.start();
		}
	}

	stop(): void {
		if (this.agentManager) {
			this.agentManager.stop();
			this.agentManager = null;
		}
	}

	hasWatcher(sessionId: string): boolean {
		return this.agentManager?.hasWatcher(sessionId) ?? false;
	}

	async ensureWatcher(
		sessionId: string,
		cwd?: string,
	): Promise<{ ready: boolean; reason?: string }> {
		if (!this.agentManager) {
			return { ready: false, reason: "Chat service is not started" };
		}
		return this.agentManager.ensureWatcher(sessionId, cwd);
	}

	private async maybeGenerateTitle(sessionId: string): Promise<void> {
		const watcher = this.agentManager?.getWatcher(sessionId);
		if (!watcher) return;

		const host = watcher.sessionHost;
		const messages = host.getMessageDigest();
		if (messages.length === 0) return;

		const userCount = messages.filter((m) => m.role === "user").length;
		if (userCount !== 1 && userCount % 10 !== 0) return;

		const { title } = await this.generateTitle(messages);
		await host.postTitle(title);
	}

	private async generateTitle(
		messages: { role: string; text: string }[],
	): Promise<{ title: string }> {
		const authToken = getAnthropicAuthToken();
		if (!authToken) {
			const firstUser = messages.find((m) => m.role === "user");
			return { title: firstUser?.text.slice(0, 40).trim() || "Untitled Chat" };
		}

		const digest = messages.map((m) => `${m.role}: ${m.text}`).join("\n");
		const provider = createAnthropic({
			authToken,
			headers: {
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
				"user-agent": "claude-cli/2.1.2 (external, cli)",
				"x-app": "cli",
			},
		});

		const result = await generateObject({
			model: provider("claude-haiku-4-5-20251001"),
			schema: titleSchema,
			system:
				"You are a title generator for a coding assistant chat. Generate a concise 2-5 word title summarizing the conversation topic.",
			prompt: digest,
		});

		return { title: result.object.title ?? "Untitled Chat" };
	}
}
