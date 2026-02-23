import type { ChatMcpIssue, ChatMcpStatus } from "@superset/chat/client";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorTrigger,
} from "@superset/ui/ai-elements/model-selector";
import { PromptInputButton } from "@superset/ui/ai-elements/prompt-input";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import {
	ChevronDownIcon,
	CircleAlertIcon,
	KeyRoundIcon,
	Loader2Icon,
	PlugZapIcon,
} from "lucide-react";
import { PILL_BUTTON_CLASS } from "../../styles";

interface DisplayMcpIssue {
	id: string;
	serverName: string | null;
	summary: string;
	detail: string | null;
	authRequired?: boolean;
}

type ServerStatus = "connected" | "needs_auth" | "failed";

interface DisplayMcpServer {
	name: string;
	status: ServerStatus;
	summary: string | null;
	detail: string | null;
}

interface StatusMeta {
	badgeClass: string;
	dotClass: string;
	label: string;
	actionHint: string;
}

function getIssueLabel(count: number): string {
	return `${count} issue${count === 1 ? "" : "s"}`;
}

function getSourceName(path: string): string {
	const segments = path.split(/[\\/]/).filter(Boolean);
	return segments.at(-1) ?? path;
}

function formatUpdatedAt(updatedAt: string | null | undefined): string | null {
	if (!updatedAt) return null;
	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleTimeString();
}

function parseLegacyMcpIssue(error: string, index: number): DisplayMcpIssue {
	const skipMatch = error.match(
		/^Skipping MCP server "([^"]+)" from (.+?): (.+)$/,
	);
	if (skipMatch?.[1] && skipMatch[2] && skipMatch[3]) {
		return {
			id: `skip-${index}`,
			serverName: skipMatch[1],
			summary: skipMatch[3],
			detail: skipMatch[2],
		};
	}

	const connectMatch = error.match(
		/^Failed to connect MCP server "([^"]+)": (.+)$/,
	);
	if (connectMatch?.[1] && connectMatch[2]) {
		return {
			id: `connect-${index}`,
			serverName: connectMatch[1],
			summary: connectMatch[2],
			detail: null,
		};
	}

	return {
		id: `other-${index}`,
		serverName: null,
		summary: error,
		detail: null,
	};
}

function parseStructuredIssue(
	issue: ChatMcpIssue,
	index: number,
): DisplayMcpIssue {
	return {
		id: `${issue.code}-${index}`,
		serverName: issue.serverName ?? null,
		summary: issue.message,
		detail: issue.source ?? null,
		authRequired: issue.authRequired,
	};
}

function getDisplayIssues(mcp: ChatMcpStatus | null): DisplayMcpIssue[] {
	if (!mcp) return [];
	if (mcp.issues.length > 0) {
		return mcp.issues.map((issue, index) => parseStructuredIssue(issue, index));
	}
	return mcp.errors.map((error, index) => parseLegacyMcpIssue(error, index));
}

function buildDisplayServers(
	mcp: ChatMcpStatus | null,
	issues: DisplayMcpIssue[],
): DisplayMcpServer[] {
	if (!mcp) return [];

	const servers = new Map<string, DisplayMcpServer>();
	for (const serverName of mcp.serverNames) {
		servers.set(serverName, {
			name: serverName,
			status: "connected",
			summary: "Connected",
			detail: null,
		});
	}

	for (const issue of issues) {
		if (!issue.serverName) continue;
		servers.set(issue.serverName, {
			name: issue.serverName,
			status: issue.authRequired ? "needs_auth" : "failed",
			summary: issue.summary,
			detail: issue.detail,
		});
	}

	return Array.from(servers.values()).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

function getStatusMeta(status: ServerStatus): StatusMeta {
	switch (status) {
		case "connected":
			return {
				badgeClass: "bg-emerald-500/10 text-emerald-700",
				dotClass: "bg-emerald-500",
				label: "Connected",
				actionHint: "Manage",
			};
		case "needs_auth":
			return {
				badgeClass: "bg-amber-500/10 text-amber-700",
				dotClass: "bg-amber-500",
				label: "Auth required",
				actionHint: "Authenticate",
			};
		case "failed":
			return {
				badgeClass: "bg-destructive/10 text-destructive",
				dotClass: "bg-destructive",
				label: "Failed",
				actionHint: "Copy error",
			};
	}
}

export function McpStatusPicker({
	mcp,
	loading,
	open,
	onOpenChange,
}: {
	mcp: ChatMcpStatus | null;
	loading: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const issues = getDisplayIssues(mcp);
	const servers = buildDisplayServers(mcp, issues);
	const issueCount = issues.length;
	const connectedCount = servers.filter(
		(server) => server.status === "connected",
	).length;
	const globalIssues = issues.filter((issue) => !issue.serverName);
	const updatedAtLabel = formatUpdatedAt(mcp?.updatedAt);
	const navigate = useNavigate();

	const handleCopyText = async (
		text: string,
		successMessage: string,
		errorMessage: string,
	): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(successMessage);
		} catch {
			toast.error(errorMessage);
		}
	};

	const handleServerSelect = (server: DisplayMcpServer): void => {
		if (server.status === "needs_auth") {
			navigate({ to: "/settings/integrations" });
			onOpenChange(false);
			return;
		}

		if (server.status === "failed") {
			void handleCopyText(
				[server.name, server.summary, server.detail].filter(Boolean).join("\n"),
				"MCP issue copied to clipboard",
				"Failed to copy MCP issue details",
			);
			return;
		}

		navigate({ to: "/settings/integrations" });
		onOpenChange(false);
	};

	return (
		<ModelSelector open={open} onOpenChange={onOpenChange}>
			<ModelSelectorTrigger asChild>
				<PromptInputButton
					className={`${PILL_BUTTON_CLASS} px-2 gap-1.5 text-xs text-foreground`}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							loading && !mcp
								? "bg-muted-foreground/50"
								: !mcp
									? "bg-border"
									: issueCount > 0
										? "bg-amber-500"
										: "bg-emerald-500",
						)}
					/>
					<span>MCP</span>
					{mcp && (
						<span className="text-muted-foreground">
							{connectedCount}/{servers.length || connectedCount}
						</span>
					)}
					{issueCount > 0 && (
						<span className="text-destructive text-[10px]">
							{getIssueLabel(issueCount)}
						</span>
					)}
					{loading && !mcp && (
						<span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
							<Loader2Icon className="size-2.5 animate-spin" />
							Loading
						</span>
					)}
					<ChevronDownIcon className="size-2.5 opacity-50" />
				</PromptInputButton>
			</ModelSelectorTrigger>
			<ModelSelectorContent title="MCP Servers">
				<ModelSelectorInput placeholder="Search MCP servers..." />
				<ModelSelectorList className="max-h-[420px]">
					<ModelSelectorEmpty>
						{loading
							? "Loading MCP status..."
							: "No MCP data yet. Status appears after chat runtime starts."}
					</ModelSelectorEmpty>
					{loading && !mcp && (
						<ModelSelectorGroup heading="Loading">
							<ModelSelectorItem
								value="loading mcp status"
								disabled
								className="data-[disabled=true]:opacity-100"
							>
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2Icon className="size-3.5 animate-spin" />
									<span>Loading MCP servers...</span>
								</div>
							</ModelSelectorItem>
						</ModelSelectorGroup>
					)}
					{mcp && (
						<>
							<ModelSelectorGroup heading={`Servers (${servers.length})`}>
								{servers.length > 0 ? (
									servers.map((server) => {
										const meta = getStatusMeta(server.status);
										return (
											<ModelSelectorItem
												key={`server-${server.name}`}
												value={`server ${server.name} ${server.status} ${server.summary ?? ""}`}
												onSelect={() => handleServerSelect(server)}
												className="items-start py-2.5"
											>
												<span
													className={cn(
														"mt-1 size-2 rounded-full shrink-0",
														meta.dotClass,
													)}
												/>
												<div className="flex min-w-0 flex-1 flex-col gap-0.5">
													<div className="flex items-center gap-2">
														<span className="truncate text-sm font-medium text-foreground">
															{server.name}
														</span>
														<span
															className={cn(
																"rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
																meta.badgeClass,
															)}
														>
															{meta.label}
														</span>
													</div>
													{server.summary && (
														<span className="truncate text-xs text-muted-foreground">
															{server.summary}
														</span>
													)}
													{server.detail && (
														<span className="truncate text-[11px] text-muted-foreground/80">
															{server.detail}
														</span>
													)}
												</div>
												<span className="text-[11px] text-muted-foreground">
													{meta.actionHint}
												</span>
											</ModelSelectorItem>
										);
									})
								) : (
									<ModelSelectorItem
										value="server none"
										disabled
										className="data-[disabled=true]:opacity-100"
									>
										<span className="text-muted-foreground text-xs">
											No MCP servers discovered
										</span>
									</ModelSelectorItem>
								)}
							</ModelSelectorGroup>

							{globalIssues.length > 0 && (
								<ModelSelectorGroup
									heading={`Other Issues (${globalIssues.length})`}
								>
									{globalIssues.map((issue) => (
										<ModelSelectorItem
											key={issue.id}
											value={`global issue ${issue.summary} ${issue.detail ?? ""}`}
											onSelect={() => {
												void handleCopyText(
													[issue.summary, issue.detail]
														.filter(Boolean)
														.join("\n"),
													"MCP issue copied to clipboard",
													"Failed to copy MCP issue",
												);
											}}
											className="items-start py-2.5"
										>
											<CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<span className="text-sm text-foreground">
													{issue.summary}
												</span>
												{issue.detail && (
													<span className="truncate text-xs text-muted-foreground">
														{issue.detail}
													</span>
												)}
											</div>
											<span className="text-[11px] text-muted-foreground">
												Copy error
											</span>
										</ModelSelectorItem>
									))}
								</ModelSelectorGroup>
							)}

							{mcp.sources.length > 0 && (
								<ModelSelectorGroup heading={`Sources (${mcp.sources.length})`}>
									{mcp.sources.map((source) => (
										<ModelSelectorItem
											key={source}
											value={`source ${source}`}
											onSelect={() => {
												void handleCopyText(
													source,
													"Source path copied to clipboard",
													"Failed to copy source path",
												);
											}}
											className="items-start py-2.5"
										>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<span className="font-mono text-xs text-foreground">
													{getSourceName(source)}
												</span>
												<span className="truncate text-[11px] text-muted-foreground">
													{source}
												</span>
											</div>
											<span className="text-[11px] text-muted-foreground">
												Copy
											</span>
										</ModelSelectorItem>
									))}
								</ModelSelectorGroup>
							)}

							<ModelSelectorGroup heading="Actions">
								<ModelSelectorItem
									value="action open integrations settings"
									onSelect={() => {
										navigate({ to: "/settings/integrations" });
										onOpenChange(false);
									}}
									className="items-start py-2.5"
								>
									<PlugZapIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
									<div className="flex flex-1 flex-col gap-0.5">
										<span className="text-sm font-medium text-foreground">
											Open Integrations settings
										</span>
										<span className="text-muted-foreground text-xs">
											Connect MCP providers and complete auth
										</span>
									</div>
								</ModelSelectorItem>
								<ModelSelectorItem
									value="action open api keys settings"
									onSelect={() => {
										navigate({ to: "/settings/api-keys" });
										onOpenChange(false);
									}}
									className="items-start py-2.5"
								>
									<KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
									<div className="flex flex-1 flex-col gap-0.5">
										<span className="text-sm font-medium text-foreground">
											Open API keys settings
										</span>
										<span className="text-muted-foreground text-xs">
											Manage MCP key-based credentials
										</span>
									</div>
								</ModelSelectorItem>
								{updatedAtLabel && (
									<ModelSelectorItem
										value={`action updated ${updatedAtLabel}`}
										disabled
									>
										<span className="text-[11px] text-muted-foreground">
											Updated {updatedAtLabel}
										</span>
									</ModelSelectorItem>
								)}
							</ModelSelectorGroup>
						</>
					)}
				</ModelSelectorList>
			</ModelSelectorContent>
		</ModelSelector>
	);
}
