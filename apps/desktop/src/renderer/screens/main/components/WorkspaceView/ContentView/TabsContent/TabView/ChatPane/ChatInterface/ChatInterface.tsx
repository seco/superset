import type { SlashCommand } from "@superset/durable-session/react";
import { useDurableChat } from "@superset/durable-session/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "renderer/env.renderer";
import { getAuthToken } from "renderer/lib/auth-client";
import { useTabsStore } from "renderer/stores/tabs/store";
import { ChatInputFooter } from "./components/ChatInputFooter";
import { MessageList } from "./components/MessageList";
import { DEFAULT_MODEL } from "./constants";
import type { ChatInterfaceProps, ModelOption, PermissionMode } from "./types";

const apiUrl = env.NEXT_PUBLIC_API_URL;

function getAuthHeaders(): Record<string, string> {
	const token = getAuthToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function createSession(
	sessionId: string,
	organizationId: string,
	deviceId: string | null,
): Promise<void> {
	const token = getAuthToken();
	await fetch(`${apiUrl}/api/streams/v1/sessions/${sessionId}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			organizationId,
			...(deviceId ? { deviceId } : {}),
		}),
	});
}

export function ChatInterface(props: ChatInterfaceProps) {
	if (props.sessionId) {
		return <ActiveChatInterface {...props} sessionId={props.sessionId} />;
	}
	return <EmptyChatInterface {...props} />;
}

function EmptyChatInterface({
	organizationId,
	deviceId,
	cwd,
	paneId,
}: ChatInterfaceProps) {
	const switchChatSession = useTabsStore((s) => s.switchChatSession);
	const [selectedModel, setSelectedModel] =
		useState<ModelOption>(DEFAULT_MODEL);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [thinkingEnabled, setThinkingEnabled] = useState(false);
	const [permissionMode, setPermissionMode] =
		useState<PermissionMode>("bypassPermissions");
	const [error, setError] = useState<string | null>(null);

	const handleSend = useCallback(
		async (message: { text: string }) => {
			const text = message.text.trim();
			if (!text || !organizationId) return;

			setError(null);
			const newSessionId = crypto.randomUUID();
			await createSession(newSessionId, organizationId, deviceId);

			// Post config BEFORE the first message so the agent has cwd/model/etc
			await fetch(
				`${apiUrl}/api/streams/v1/sessions/${newSessionId}/config`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...getAuthHeaders(),
					},
					body: JSON.stringify({
						model: selectedModel.id,
						permissionMode,
						thinkingEnabled,
						cwd,
					}),
				},
			);

			// Send the first message before switching so it isn't lost
			await fetch(
				`${apiUrl}/api/streams/v1/sessions/${newSessionId}/messages`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...getAuthHeaders(),
					},
					body: JSON.stringify({ content: text }),
				},
			);

			switchChatSession(paneId, newSessionId);
		},
		[
			organizationId,
			deviceId,
			paneId,
			switchChatSession,
			selectedModel.id,
			permissionMode,
			thinkingEnabled,
			cwd,
		],
	);

	return (
		<div className="flex h-full flex-col bg-background">
			<MessageList messages={[]} isStreaming={false} />
			<ChatInputFooter
				cwd={cwd}
				error={error}
				isStreaming={false}
				availableModels={[]}
				selectedModel={selectedModel}
				setSelectedModel={setSelectedModel}
				modelSelectorOpen={modelSelectorOpen}
				setModelSelectorOpen={setModelSelectorOpen}
				permissionMode={permissionMode}
				setPermissionMode={setPermissionMode}
				thinkingEnabled={thinkingEnabled}
				setThinkingEnabled={setThinkingEnabled}
				slashCommands={[]}
				onSend={handleSend}
				onStop={() => {}}
				onSlashCommandSend={() => {}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ActiveChatInterface — self-contained via useDurableChat
// ---------------------------------------------------------------------------

function ActiveChatInterface({
	sessionId,
	cwd,
}: Omit<ChatInterfaceProps, "sessionId"> & { sessionId: string }) {
	const [selectedModel, setSelectedModel] =
		useState<ModelOption>(DEFAULT_MODEL);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [thinkingEnabled, setThinkingEnabled] = useState(false);
	const [permissionMode, setPermissionMode] =
		useState<PermissionMode>("bypassPermissions");

	const { ready, messages, isLoading, sendMessage, stop, error, metadata } =
		useDurableChat({
			sessionId,
			proxyUrl: apiUrl,
			getHeaders: getAuthHeaders,
		});

	const isStreaming = isLoading;

	const registeredRef = useRef(false);
	useEffect(() => {
		if (!ready || registeredRef.current) return;
		registeredRef.current = true;
		metadata.updateConfig({
			model: selectedModel.id,
			permissionMode,
			thinkingEnabled,
			cwd,
		});
	}, [
		ready,
		cwd,
		metadata.updateConfig,
		permissionMode,
		selectedModel.id,
		thinkingEnabled,
	]);

	const prevConfigRef = useRef({
		modelId: selectedModel.id,
		permissionMode,
		thinkingEnabled,
	});
	useEffect(() => {
		const prev = prevConfigRef.current;
		if (
			prev.modelId === selectedModel.id &&
			prev.permissionMode === permissionMode &&
			prev.thinkingEnabled === thinkingEnabled
		) {
			return;
		}
		prevConfigRef.current = {
			modelId: selectedModel.id,
			permissionMode,
			thinkingEnabled,
		};
		metadata.updateConfig({
			model: selectedModel.id,
			permissionMode,
			thinkingEnabled,
			cwd,
		});
	}, [
		selectedModel.id,
		permissionMode,
		thinkingEnabled,
		cwd,
		metadata.updateConfig,
	]);

	const handleSend = useCallback(
		(message: { text: string }) => {
			const text = message.text.trim();
			if (!text) return;
			sendMessage(text);
		},
		[sendMessage],
	);

	const handleStop = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			stop();
		},
		[stop],
	);

	const handleSlashCommandSend = useCallback(
		(command: SlashCommand) => {
			handleSend({ text: `/${command.name}` });
		},
		[handleSend],
	);

	if (!ready) {
		return (
			<div className="flex h-full flex-col items-center justify-center bg-background">
				<p className="text-muted-foreground text-sm">Connecting…</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col bg-background">
			<MessageList messages={messages} isStreaming={isStreaming} />
			<ChatInputFooter
				cwd={cwd}
				error={error}
				isStreaming={isStreaming}
				availableModels={metadata.config.availableModels ?? []}
				selectedModel={selectedModel}
				setSelectedModel={setSelectedModel}
				modelSelectorOpen={modelSelectorOpen}
				setModelSelectorOpen={setModelSelectorOpen}
				permissionMode={permissionMode}
				setPermissionMode={setPermissionMode}
				thinkingEnabled={thinkingEnabled}
				setThinkingEnabled={setThinkingEnabled}
				slashCommands={metadata.config.slashCommands ?? []}
				onSend={handleSend}
				onStop={handleStop}
				onSlashCommandSend={handleSlashCommandSend}
			/>
		</div>
	);
}
