export interface OAuthTokenSyncOptions {
	forceRefresh?: boolean;
}

export type SyncAnthropicOAuthToken = (
	options?: OAuthTokenSyncOptions,
) => Promise<boolean>;

export function isAnthropicOAuthExpiredError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();

	if (normalized.includes("oauth token has expired")) {
		return true;
	}
	if (
		normalized.includes("authentication_error") &&
		normalized.includes("oauth")
	) {
		return true;
	}
	if (
		normalized.includes("api.anthropic.com") &&
		normalized.includes("token") &&
		normalized.includes("expired")
	) {
		return true;
	}

	return false;
}

export async function withAnthropicOAuthRetry<T>(
	operation: () => Promise<T>,
	options: {
		syncToken: SyncAnthropicOAuthToken;
		onRetry?: () => void;
	},
): Promise<T> {
	await options.syncToken();

	try {
		return await operation();
	} catch (error) {
		if (!isAnthropicOAuthExpiredError(error)) {
			throw error;
		}

		const refreshed = await options.syncToken({ forceRefresh: true });
		if (!refreshed) {
			throw error;
		}

		options.onRetry?.();
		return operation();
	}
}
