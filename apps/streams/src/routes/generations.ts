import { Hono } from "hono";
import { z } from "zod";
import type { SessionProtocol } from "../protocol";

const startBodySchema = z.object({
	messageId: z.string(),
});

const finishBodySchema = z.object({
	messageId: z.string().optional(),
});

export function createGenerationRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.post("/:sessionId/generations/start", async (c) => {
		const sessionId = c.req.param("sessionId");

		let body: z.infer<typeof startBodySchema>;
		try {
			const rawBody = await c.req.json();
			body = startBodySchema.parse(rawBody);
		} catch (error) {
			return c.json(
				{
					error: "Invalid request body",
					details: (error as Error).message,
				},
				400,
			);
		}

		try {
			if (!protocol.getSession(sessionId)) {
				return c.json({ error: "Session not found" }, 404);
			}

			protocol.startGeneration({ sessionId, messageId: body.messageId });
			return c.json({ ok: true });
		} catch (error) {
			console.error("Failed to start generation:", error);
			return c.json(
				{
					error: "Failed to start generation",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	app.post("/:sessionId/generations/finish", async (c) => {
		const sessionId = c.req.param("sessionId");

		let messageId: string | undefined;
		try {
			const rawBody = await c.req.json();
			const parsed = finishBodySchema.parse(rawBody);
			messageId = parsed.messageId;
		} catch {
			// No body or invalid JSON — messageId is optional
		}

		try {
			if (!protocol.getSession(sessionId)) {
				return c.json({ error: "Session not found" }, 404);
			}

			await protocol.finishGeneration({ sessionId, messageId });
			return c.json({ ok: true, sessionId, messageId });
		} catch (error) {
			console.error("[generations] Finish failed:", (error as Error).message);
			return c.json(
				{
					ok: false,
					error: "Generation finish failed",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	return app;
}
