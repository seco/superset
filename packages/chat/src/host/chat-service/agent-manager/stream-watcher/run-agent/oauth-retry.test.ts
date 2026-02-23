import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_OAUTH_REAUTH_REQUIRED_MESSAGE,
	AnthropicOAuthReauthRequiredError,
	isAnthropicOAuthExpiredError,
	isAnthropicOAuthReauthRequiredError,
	withAnthropicOAuthRetry,
} from "./oauth-retry";

describe("isAnthropicOAuthExpiredError", () => {
	it("matches known Anthropic OAuth expiration signatures", () => {
		expect(
			isAnthropicOAuthExpiredError(
				new Error(
					"OAuth token has expired. Please obtain a new token or refresh your existing token.",
				),
			),
		).toBe(true);
		expect(
			isAnthropicOAuthExpiredError(
				new Error(
					'{"type":"authentication_error","message":"oauth token expired"}',
				),
			),
		).toBe(true);
		expect(
			isAnthropicOAuthExpiredError(
				new Error("POST https://api.anthropic.com token is expired"),
			),
		).toBe(true);
	});

	it("does not match non-auth errors", () => {
		expect(isAnthropicOAuthExpiredError(new Error("network timeout"))).toBe(
			false,
		);
	});
});

describe("withAnthropicOAuthRetry", () => {
	it("rethrows non-oauth errors without retry", async () => {
		const syncToken = mock(async () => true);

		await expect(
			withAnthropicOAuthRetry(
				async () => {
					throw new Error("unrelated failure");
				},
				{ syncToken },
			),
		).rejects.toThrow("unrelated failure");

		expect(syncToken).toHaveBeenCalledTimes(1);
	});

	it("retries once when oauth token is expired and refresh succeeds", async () => {
		const syncCalls: Array<{ forceRefresh?: boolean } | undefined> = [];
		const syncToken = mock(async (options?: { forceRefresh?: boolean }) => {
			syncCalls.push(options);
			return true;
		});
		const onRetry = mock(() => {});
		let attempts = 0;

		const result = await withAnthropicOAuthRetry(
			async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error(
						"OAuth token has expired. Please obtain a new token or refresh your existing token.",
					);
				}
				return "ok";
			},
			{ syncToken, onRetry },
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(syncToken).toHaveBeenCalledTimes(2);
		expect(syncCalls[0]).toBeUndefined();
		expect(syncCalls[1]).toEqual({ forceRefresh: true });
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("rethrows when refresh fails after oauth expiration", async () => {
		const syncToken = mock(
			async (options?: { forceRefresh?: boolean }) => !options?.forceRefresh,
		);
		let attempts = 0;

		await expect(
			withAnthropicOAuthRetry(
				async () => {
					attempts++;
					throw new Error(
						'{"type":"authentication_error","message":"oauth token expired"}',
					);
				},
				{ syncToken },
			),
		).rejects.toThrow(ANTHROPIC_OAUTH_REAUTH_REQUIRED_MESSAGE);

		expect(attempts).toBe(1);
		expect(syncToken).toHaveBeenCalledTimes(2);
	});

	it("identifies oauth reauth required errors", () => {
		expect(
			isAnthropicOAuthReauthRequiredError(
				new AnthropicOAuthReauthRequiredError(),
			),
		).toBe(true);
		expect(
			isAnthropicOAuthReauthRequiredError(
				new Error(ANTHROPIC_OAUTH_REAUTH_REQUIRED_MESSAGE),
			),
		).toBe(true);
		expect(isAnthropicOAuthReauthRequiredError(new Error("unrelated"))).toBe(
			false,
		);
	});
});
