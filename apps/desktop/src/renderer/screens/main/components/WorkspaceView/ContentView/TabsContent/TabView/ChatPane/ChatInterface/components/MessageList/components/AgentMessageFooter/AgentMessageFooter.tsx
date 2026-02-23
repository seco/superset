import type { AssistantMessageMetadata } from "@superset/chat/client";
import {
	MessageAction,
	MessageActions,
} from "@superset/ui/ai-elements/message";
import { CheckIcon, CopyIcon, GitForkIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { AsciiSpinner } from "renderer/screens/main/components/AsciiSpinner";
import { useElapsedTimer } from "./hooks/useElapsedTimer";

interface AgentMessageFooterProps {
	/** Epoch ms when the user sent the triggering message (timer start). */
	startedAt: number;
	metadata?: AssistantMessageMetadata;
	isStreaming: boolean;
	messageText: string;
}

export function AgentMessageFooter({
	startedAt,
	metadata,
	isStreaming,
	messageText,
}: AgentMessageFooterProps) {
	const elapsed = useElapsedTimer(startedAt, isStreaming);
	const [isCopied, setIsCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(messageText);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
		} catch {
			// clipboard API unavailable
		}
	}, [messageText]);

	if (isStreaming) {
		return (
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
				<AsciiSpinner className="text-xs" />
				<span>{elapsed.toFixed(1)}s</span>
			</div>
		);
	}

	// For completed messages, prefer finishedAt from stream metadata for accuracy
	const finishedElapsed = metadata?.finishedAt
		? (new Date(metadata.finishedAt).getTime() - startedAt) / 1000
		: elapsed;
	const displaySeconds = Math.round(finishedElapsed);

	return (
		<div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
			<span>{displaySeconds}s</span>
			<span className="select-none">&middot;</span>
			<MessageActions>
				<MessageAction
					tooltip={isCopied ? "Copied" : "Copy"}
					onClick={handleCopy}
				>
					<div className="relative size-3.5">
						<CopyIcon
							className={`absolute inset-0 size-3.5 transition-all duration-200 ${isCopied ? "scale-50 opacity-0" : "scale-100 opacity-100"}`}
						/>
						<CheckIcon
							className={`absolute inset-0 size-3.5 transition-all duration-200 ${isCopied ? "scale-100 opacity-100" : "scale-50 opacity-0"}`}
						/>
					</div>
				</MessageAction>
				<MessageAction tooltip="Fork from here" onClick={() => {}}>
					<GitForkIcon className="size-3.5" />
				</MessageAction>
				<MessageAction tooltip="Replay from here" onClick={() => {}}>
					<RotateCcwIcon className="size-3.5" />
				</MessageAction>
			</MessageActions>
		</div>
	);
}
