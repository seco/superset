import type { CommandStatus } from "@superset/db/schema";
import type { AppRouter } from "@superset/trpc";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { env } from "renderer/env.renderer";
import { getAuthToken } from "renderer/lib/auth-client";
import superjson from "superjson";

const apiClient = createTRPCProxyClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${env.NEXT_PUBLIC_API_URL}/api/trpc`,
			headers: () => {
				const token = getAuthToken();
				return token ? { Authorization: `Bearer ${token}` } : {};
			},
			transformer: superjson,
		}),
	],
});

export async function persistCommandStatus(params: {
	id: string;
	status: CommandStatus;
	claimedBy?: string;
	claimedAt?: Date;
	result?: Record<string, unknown>;
	error?: string;
	executedAt?: Date;
}): Promise<void> {
	const delays = [500, 1000, 2000];
	let lastError: unknown;

	for (let attempt = 0; attempt <= delays.length; attempt++) {
		try {
			await apiClient.agent.updateCommand.mutate(params);
			return;
		} catch (err) {
			lastError = err;
			console.warn(
				`[persistCommandStatus] Attempt ${attempt + 1} failed for ${params.id}:`,
				err,
			);
			if (attempt < delays.length) {
				await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			}
		}
	}

	console.error(
		`[persistCommandStatus] All retries exhausted for ${params.id}:`,
		lastError,
	);
}
