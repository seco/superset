import { z } from "zod";

export const chatMastraEnvelopeSchema = z.object({
	kind: z.enum(["submit", "harness"]),
	sessionId: z.string().uuid(),
	timestamp: z.string(),
	sequenceHint: z.number().int().nonnegative(),
	payload: z.unknown(),
});

export type ChatMastraEnvelope = z.infer<typeof chatMastraEnvelopeSchema>;

