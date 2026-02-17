import { Hono } from "hono";
import type { SessionProtocol } from "../protocol";

export function createSessionRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.put("/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId");

		try {
			await protocol.getOrCreateSession(sessionId);
			return c.json({ sessionId }, 201);
		} catch (error) {
			console.error("Failed to create session:", error);
			return c.json(
				{
					error: "Failed to create session",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	app.get("/:sessionId", (c) => {
		const sessionId = c.req.param("sessionId");

		const stream = protocol.getSession(sessionId);
		if (!stream) {
			return c.json({ error: "Session not found" }, 404);
		}

		return c.json({
			sessionId,
			streamUrl: `/v1/stream/sessions/${sessionId}`,
		});
	});

	app.delete("/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId");

		try {
			await protocol.deleteSession(sessionId);
			return new Response(null, { status: 204 });
		} catch (error) {
			console.error("Failed to delete session:", error);
			return c.json(
				{
					error: "Failed to delete session",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	return app;
}
