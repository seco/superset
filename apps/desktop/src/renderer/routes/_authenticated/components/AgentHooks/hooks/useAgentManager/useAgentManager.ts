import { useEffect, useRef } from "react";
import { authClient } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Starts the AgentManager on the main process when auth is ready.
 * Restarts when the active organization changes.
 */
export function useAgentManager() {
	const { data: session } = authClient.useSession();
	const organizationId = session?.session?.activeOrganizationId;
	const startMutation = electronTrpc.agentManager.start.useMutation();
	const prevOrgRef = useRef<string | null>(null);

	useEffect(() => {
		if (!organizationId) return;
		if (organizationId === prevOrgRef.current) return;

		prevOrgRef.current = organizationId;
		startMutation.mutate({ organizationId });
	}, [organizationId, startMutation]);
}
