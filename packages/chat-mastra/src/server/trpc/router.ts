import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { searchFiles } from "./utils/file-search";
import {
	approvalRespondInput,
	controlInput,
	ensureRuntimeInput,
	planRespondInput,
	questionRespondInput,
	searchFilesInput,
	sendMessageInput,
	sessionIdInput,
	startInput,
	toolOutputInput,
} from "./zod";

const t = initTRPC.create({ transformer: superjson });

interface RuntimeState {
	sessionId: string;
	cwd?: string;
	createdAt: Date;
	updatedAt: Date;
}

export function createChatMastraServiceRouter() {
	let started = false;
	const runtimes = new Map<string, RuntimeState>();

	return t.router({
		start: t.procedure.input(startInput).mutation(async () => {
			started = true;
			return { success: true };
		}),

		stop: t.procedure.mutation(() => {
			started = false;
			runtimes.clear();
			return { success: true };
		}),

		workspace: t.router({
			searchFiles: t.procedure
				.input(searchFilesInput)
				.query(async ({ input }) => {
					return searchFiles({
						rootPath: input.rootPath,
						query: input.query,
						includeHidden: input.includeHidden,
						limit: input.limit,
					});
				}),
		}),

		session: t.router({
			isActive: t.procedure.input(sessionIdInput).query(({ input }) => {
				return {
					active: runtimes.has(input.sessionId),
				};
			}),

			ensureRuntime: t.procedure
				.input(ensureRuntimeInput)
				.mutation(async ({ input }) => {
					if (!started) {
						return {
							ready: false,
							reason: "Chat Mastra service is not started",
						};
					}

					const now = new Date();
					const existing = runtimes.get(input.sessionId);
					if (existing) {
						existing.cwd = input.cwd ?? existing.cwd;
						existing.updatedAt = now;
						runtimes.set(input.sessionId, existing);
						return { ready: true };
					}

					runtimes.set(input.sessionId, {
						sessionId: input.sessionId,
						cwd: input.cwd,
						createdAt: now,
						updatedAt: now,
					});

					return { ready: true };
				}),

			sendMessage: t.procedure
				.input(sendMessageInput)
				.mutation(async ({ input }) => {
					const runtime = runtimes.get(input.sessionId);
					if (!runtime) return { accepted: false };
					runtime.updatedAt = new Date();
					runtimes.set(input.sessionId, runtime);
					return { accepted: true };
				}),

			control: t.procedure.input(controlInput).mutation(async ({ input }) => {
				const runtime = runtimes.get(input.sessionId);
				if (!runtime) return { accepted: false };
				runtime.updatedAt = new Date();
				runtimes.set(input.sessionId, runtime);
				return { accepted: true };
			}),

			toolOutput: t.procedure
				.input(toolOutputInput)
				.mutation(async () => ({ accepted: true })),

			approval: t.router({
				respond: t.procedure
					.input(approvalRespondInput)
					.mutation(async () => ({ accepted: true })),
			}),

			question: t.router({
				respond: t.procedure
					.input(questionRespondInput)
					.mutation(async () => ({ accepted: true })),
			}),

			plan: t.router({
				respond: t.procedure
					.input(planRespondInput)
					.mutation(async () => ({ accepted: true })),
			}),
		}),
	});
}

export type ChatMastraServiceRouter = ReturnType<
	typeof createChatMastraServiceRouter
>;
