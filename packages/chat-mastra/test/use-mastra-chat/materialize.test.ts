import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	materializeMastraChatState,
	type MastraChatEventEnvelope,
} from "../../src/client/use-mastra-chat";

interface ProbeFixtureRecord {
	timestamp: string;
	sessionId?: string;
	sequenceHint?: number;
	channel: "service" | "submit" | "harness";
	payload: unknown;
}

function loadFixture(name: string): ProbeFixtureRecord[] {
	const fixturePath = path.join(
		import.meta.dir,
		"..",
		"fixtures",
		"mastra-events",
		name,
	);
	return JSON.parse(readFileSync(fixturePath, "utf8")) as ProbeFixtureRecord[];
}

function toChatEnvelopes(
	records: ReadonlyArray<ProbeFixtureRecord>,
): MastraChatEventEnvelope[] {
	const envelopes: MastraChatEventEnvelope[] = [];
	for (const record of records) {
		if (record.channel !== "submit" && record.channel !== "harness") continue;
		if (!record.sessionId) continue;
		if (typeof record.sequenceHint !== "number") continue;
		envelopes.push({
			kind: record.channel,
			sessionId: record.sessionId,
			timestamp: record.timestamp,
			sequenceHint: record.sequenceHint,
			payload: record.payload,
		});
	}
	return envelopes;
}

describe("materializeMastraChatState", () => {
	it("materializes submit + harness lifecycle for auth error flow", () => {
		const records = toChatEnvelopes(
			loadFixture("session-basic-auth-error.json"),
		);
		const state = materializeMastraChatState(records);

		expect(state.sessionId).toBe("11111111-1111-4111-8111-111111111111");
		expect(state.epoch).toBe(1);
		expect(state.sequenceResetCount).toBe(0);
		expect(state.isRunning).toBeFalse();
		expect(state.lastAgentEndReason).toBe("complete");

		expect(state.messages).toHaveLength(2);
		expect(state.messages[0]).toMatchObject({
			role: "user",
			text: "Say hello in one word",
			source: "submit",
			status: "complete",
		});
		expect(state.messages[1]).toMatchObject({
			role: "assistant",
			source: "harness",
			status: "complete",
		});

		expect(state.errors).toHaveLength(1);
		expect(state.errors[0]?.message).toContain("Not logged in to Anthropic");
		expect(state.usage).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});

		expect(state.controls).toHaveLength(0);
		expect(
			state.auxiliaryEvents.some((event) => event.type === "om_status"),
		).toBeTrue();
	});

	it("captures late abort control as non-running submission", () => {
		const records = toChatEnvelopes(loadFixture("session-late-abort.json"));
		const state = materializeMastraChatState(records);

		expect(state.sessionId).toBe("22222222-2222-4222-8222-222222222222");
		expect(state.controls).toEqual([
			{
				action: "abort",
				submittedAt: "2026-02-24T05:56:11.336Z",
				wasRunning: false,
			},
		]);
		expect(state.isRunning).toBeFalse();
		expect(state.lastAgentEndReason).toBe("complete");
		expect(state.messages[0]?.text).toBe(
			"Write a long answer about distributed systems",
		);
	});

	it("handles crash/restart sequence reset without dropping history", () => {
		const records = toChatEnvelopes(loadFixture("session-crash-resume.json"));
		const state = materializeMastraChatState(records);

		expect(state.sessionId).toBe("55555555-5555-4555-8555-555555555555");
		expect(state.sequenceResetCount).toBe(1);
		expect(state.epoch).toBe(2);

		const userTexts = state.messages
			.filter((message) => message.role === "user")
			.map((message) => message.text);
		expect(userTexts).toEqual(["crash-test message", "post-crash message"]);

		expect(state.errors).toHaveLength(1);
		expect(state.errors[0]?.message).toContain("Not logged in to Anthropic");
	});

	it("can materialize per-session slices from global logs", () => {
		const globalRecords = loadFixture("global-with-crash-service-events.json");
		const sessionRecords = toChatEnvelopes(
			globalRecords.filter(
				(record) =>
					record.sessionId === "33333333-3333-4333-8333-333333333333",
			),
		);
		const state = materializeMastraChatState(sessionRecords);

		expect(state.sessionId).toBe("33333333-3333-4333-8333-333333333333");
		expect(state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(state.messages[0]?.text).toBe("alpha");
		expect(state.controls).toHaveLength(0);
	});
});
