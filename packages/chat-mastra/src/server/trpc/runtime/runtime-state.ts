import { createMastraCode } from "mastracode";
import {
	createSessionStreamProducer,
	ensureSessionStream,
	type ChatMastraStreamsConfig,
	type SessionStreamProducer,
} from "../../../events/durable-streams";
import type { ChatMastraEnvelope } from "../../../schema";
import { chatMastraSessionStateSchema } from "../../../session-db/schema";
import type {
	ApprovalRespondInput,
	ControlInput,
	EnsureRuntimeInput,
	PlanRespondInput,
	QuestionRespondInput,
	SendMessageInput,
} from "../zod";

interface RuntimeSession {
	sessionId: string;
	harness: ReturnType<typeof createMastraCode>["harness"];
	producer: SessionStreamProducer;
	unsubscribe: () => void;
	sequenceHint: number;
	cwd?: string;
}

export interface RuntimeConfig {
	streams: ChatMastraStreamsConfig;
}

let runtimeConfig: RuntimeConfig | null = null;
let started = false;
let organizationId: string | null = null;
const runtimes = new Map<string, RuntimeSession>();
const commandTails = new Map<string, Promise<void>>();

function getRuntimeConfig(): RuntimeConfig {
	if (!runtimeConfig) {
		throw new Error("Runtime config not set. Call configureRuntimeState() first.");
	}
	return runtimeConfig;
}

function toMastraImages(
	files: Array<{ url: string; mediaType: string; filename?: string }> | undefined,
): Array<{ data: string; mimeType: string }> {
	if (!files || files.length === 0) return [];

	const images: Array<{ data: string; mimeType: string }> = [];
	for (const file of files) {
		if (!file.url.startsWith("data:")) continue;
		const commaIndex = file.url.indexOf(",");
		if (commaIndex <= 0) continue;
		const header = file.url.slice(0, commaIndex);
		const data = file.url.slice(commaIndex + 1);
		if (!header.includes(";base64")) continue;
		if (!data) continue;
		images.push({
			data,
			mimeType: file.mediaType,
		});
	}

	return images;
}

function appendEvent(
	runtime: RuntimeSession,
	kind: ChatMastraEnvelope["kind"],
	payload: ChatMastraEnvelope["payload"],
): void {
	const sequenceHint = runtime.sequenceHint;
	const envelope: ChatMastraEnvelope = {
		kind,
		sessionId: runtime.sessionId,
		timestamp: new Date().toISOString(),
		sequenceHint,
		payload,
	};
	const stateEvent = chatMastraSessionStateSchema.events.insert({
		key: `${runtime.sessionId}:${sequenceHint}`,
		value: envelope,
	});
	runtime.sequenceHint += 1;
	runtime.producer.append(JSON.stringify(stateEvent));
}

async function withSessionCommandLock<T>(
	sessionId: string,
	task: () => Promise<T>,
): Promise<T> {
	const previous = commandTails.get(sessionId) ?? Promise.resolve();
	let releaseTail: () => void = () => {};
	const nextTail = new Promise<void>((resolve) => {
		releaseTail = resolve;
	});
	commandTails.set(
		sessionId,
		previous
			.catch(() => {})
			.then(() => nextTail),
	);

	try {
		await previous.catch(() => {});
		return await task();
	} finally {
		releaseTail();
	}
}

async function stopRuntime(sessionId: string): Promise<void> {
	const runtime = runtimes.get(sessionId);
	if (!runtime) return;

	runtime.unsubscribe();
	try {
		await runtime.producer.flush();
	} finally {
		await runtime.producer.detach().catch(() => {});
	}
	runtimes.delete(sessionId);
	commandTails.delete(sessionId);
}

export function configureRuntimeState(config: RuntimeConfig): void {
	runtimeConfig = config;
}

export function startRuntimeService(nextOrganizationId: string): void {
	started = true;
	organizationId = nextOrganizationId;
}

export async function stopRuntimeService(): Promise<void> {
	started = false;
	organizationId = null;
	await Promise.all([...runtimes.keys()].map((sessionId) => stopRuntime(sessionId)));
}

export function hasRuntime(sessionId: string): boolean {
	return runtimes.has(sessionId);
}

export async function ensureRuntime(
	input: EnsureRuntimeInput,
): Promise<{ ready: boolean; reason?: string }> {
	if (!started) {
		return {
			ready: false,
			reason: "Chat Mastra service is not started",
		};
	}

	const activeOrganizationId = organizationId;
	if (!activeOrganizationId) {
		return {
			ready: false,
			reason: "No active organization. Call start() before ensureRuntime().",
		};
	}

	return withSessionCommandLock(input.sessionId, async () => {
		const existing = runtimes.get(input.sessionId);
		if (existing) {
			existing.cwd = input.cwd ?? existing.cwd;
			runtimes.set(input.sessionId, existing);
			return { ready: true };
		}

		const config = getRuntimeConfig();
		await ensureSessionStream(config.streams, {
			sessionId: input.sessionId,
			organizationId: activeOrganizationId,
			workspaceId: input.workspaceId,
		});

		const producer = createSessionStreamProducer(config.streams, input.sessionId);
		const cwd = input.cwd ?? process.cwd();
		const runtimeMastra = createMastraCode({ cwd });
		await runtimeMastra.harness.init();
		runtimeMastra.harness.setResourceId({ resourceId: input.sessionId });
		await runtimeMastra.harness.selectOrCreateThread();

		const runtime: RuntimeSession = {
			sessionId: input.sessionId,
			harness: runtimeMastra.harness,
			producer,
			unsubscribe: () => {},
			sequenceHint: 0,
			cwd,
		};

		runtimes.set(input.sessionId, runtime);
		runtime.unsubscribe = runtime.harness.subscribe((event) => {
			const current = runtimes.get(input.sessionId);
			if (!current) return;
			appendEvent(current, "harness", event);
		});

		return { ready: true };
	});
}

export async function sendMessage(
	input: SendMessageInput,
): Promise<{ accepted: boolean }> {
	return withSessionCommandLock(input.sessionId, async () => {
		const runtime = runtimes.get(input.sessionId);
		if (!runtime) return { accepted: false };

		appendEvent(runtime, "submit", {
			type: "user_message_submitted",
			data: {
				content: input.content ?? "",
				files: input.files ?? [],
				metadata: input.metadata,
				clientMessageId: input.clientMessageId,
			},
		});

		const images = toMastraImages(input.files);
		await runtime.harness.sendMessage({
			content: input.content ?? "",
			...(images.length > 0 ? { images } : {}),
		});

		return { accepted: true };
	});
}

export async function control(input: ControlInput): Promise<{ accepted: boolean }> {
	return withSessionCommandLock(input.sessionId, async () => {
		const runtime = runtimes.get(input.sessionId);
		if (!runtime) return { accepted: false };

		appendEvent(runtime, "submit", {
			type: "control_submitted",
			data: {
				action: input.action,
			},
		});

		if (input.action === "stop" || input.action === "abort") {
			runtime.harness.abort();
		}

		return { accepted: true };
	});
}

export async function approvalRespond(
	input: ApprovalRespondInput,
): Promise<{ accepted: boolean }> {
	return withSessionCommandLock(input.sessionId, async () => {
		const runtime = runtimes.get(input.sessionId);
		if (!runtime) return { accepted: false };

		appendEvent(runtime, "submit", {
			type: "approval_submitted",
			data: {
				decision: input.decision,
				toolCallId: input.toolCallId,
			},
		});

		runtime.harness.respondToToolApproval({
			decision: input.decision === "approve" ? "approve" : "decline",
		});

		return { accepted: true };
	});
}

export async function questionRespond(
	input: QuestionRespondInput,
): Promise<{ accepted: boolean }> {
	return withSessionCommandLock(input.sessionId, async () => {
		const runtime = runtimes.get(input.sessionId);
		if (!runtime) return { accepted: false };

		appendEvent(runtime, "submit", {
			type: "question_submitted",
			data: {
				questionId: input.questionId,
				answer: input.answer,
			},
		});

		runtime.harness.respondToQuestion({
			questionId: input.questionId,
			answer: input.answer,
		});

		return { accepted: true };
	});
}

export async function planRespond(
	input: PlanRespondInput,
): Promise<{ accepted: boolean }> {
	return withSessionCommandLock(input.sessionId, async () => {
		const runtime = runtimes.get(input.sessionId);
		if (!runtime) return { accepted: false };

		appendEvent(runtime, "submit", {
			type: "plan_submitted",
			data: {
				planId: input.planId,
				action: input.action,
				feedback: input.feedback,
			},
		});

		await runtime.harness.respondToPlanApproval({
			planId: input.planId,
			response: {
				action: input.action === "accept" ? "approved" : "rejected",
				feedback: input.feedback,
			},
		});

		return { accepted: true };
	});
}
