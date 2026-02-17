import { Hono } from "hono";
import { z } from "zod";
import type { SessionProtocol } from "../protocol";

const sendMessageSchema = z.object({
	content: z.string(),
	userId: z.string().optional(),
	messageId: z.string().optional(),
	txid: z.string().optional(),
});

export function createMessageRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.post("/:sessionId/messages", async (c) => {
		const sessionId = c.req.param("sessionId");

		let body: z.infer<typeof sendMessageSchema>;
		try {
			const rawBody = await c.req.json();
			body = sendMessageSchema.parse(rawBody);
		} catch (error) {
			return c.json(
				{
					error: "Invalid request body",
					details: (error as Error).message,
				},
				400,
			);
		}

		const userId =
			body.userId ?? c.req.header("X-Actor-Id") ?? crypto.randomUUID();
		const messageId = body.messageId ?? crypto.randomUUID();

		try {
			await protocol.getOrCreateSession(sessionId);
			await protocol.writeUserMessage(
				sessionId,
				messageId,
				userId,
				body.content,
				body.txid,
			);

			return c.json({ messageId });
		} catch (error) {
			console.error("Failed to send message:", error);
			return c.json(
				{
					error: "Failed to send message",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	return app;
}
