import { setAnthropicAuthToken } from "@superset/agent";
import { getOrRefreshAnthropicOAuthCredentials } from "../../../../auth/anthropic";
import {
	type OAuthTokenSyncOptions,
	withAnthropicOAuthRetry,
} from "./oauth-retry";

export async function syncAnthropicOAuthToken(
	options?: OAuthTokenSyncOptions,
): Promise<boolean> {
	try {
		const oauthCredentials = await getOrRefreshAnthropicOAuthCredentials({
			forceRefresh: options?.forceRefresh,
		});

		if (!oauthCredentials) {
			setAnthropicAuthToken(null);
			return false;
		}

		setAnthropicAuthToken(oauthCredentials.apiKey);
		return true;
	} catch (error) {
		console.warn("[run-agent] Failed to sync Anthropic OAuth token:", error);
		if (options?.forceRefresh) {
			setAnthropicAuthToken(null);
		}
		return false;
	}
}

export async function runWithAnthropicOAuthRetry<T>(
	operation: () => Promise<T>,
): Promise<T> {
	return withAnthropicOAuthRetry(operation, {
		syncToken: syncAnthropicOAuthToken,
		onRetry: () => {
			console.warn(
				"[run-agent] Retrying agent call after Anthropic OAuth refresh",
			);
		},
	});
}
