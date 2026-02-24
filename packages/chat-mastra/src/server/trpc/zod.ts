import { z } from "zod";

export const startInput = z.object({
	organizationId: z.string(),
});

export const searchFilesInput = z.object({
	rootPath: z.string(),
	query: z.string(),
	includeHidden: z.boolean().default(false),
	limit: z.number().default(20),
});

export const sessionIdInput = z.object({
	sessionId: z.uuid(),
});

export const ensureRuntimeInput = z.object({
	sessionId: z.uuid(),
	cwd: z.string().optional(),
});

export const sendMessageInput = z.object({
	sessionId: z.uuid(),
	content: z.string().optional(),
	files: z
		.array(
			z.object({
				url: z.string(),
				mediaType: z.string(),
				filename: z.string().optional(),
			}),
		)
		.optional(),
	metadata: z
		.object({
			model: z.string().optional(),
			permissionMode: z.string().optional(),
			thinkingEnabled: z.boolean().optional(),
		})
		.optional(),
	clientMessageId: z.string().optional(),
});

export const controlInput = z.object({
	sessionId: z.string().uuid(),
	action: z.string(),
});

export const toolOutputInput = z.object({
	sessionId: z.string().uuid(),
	tool: z.string(),
	toolCallId: z.string(),
	output: z.unknown().optional(),
	error: z.string().optional(),
});

export const approvalRespondInput = z.object({
	sessionId: z.string().uuid(),
	decision: z.enum(["approve", "deny"]),
	toolCallId: z.string().optional(),
});

export const questionRespondInput = z.object({
	sessionId: z.string().uuid(),
	questionId: z.string(),
	answer: z.string(),
});

export const planRespondInput = z.object({
	sessionId: z.string().uuid(),
	planId: z.string(),
	action: z.enum(["accept", "reject", "revise"]),
	feedback: z.string().optional(),
});
