import { Hono } from "hono";
import type { SessionProtocol } from "../protocol";

export function createStopRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.post("/:sessionId/stop", async (c) => {
		const sessionId = c.req.param("sessionId");

		try {
			protocol.stopGeneration(sessionId);
			return c.json({ ok: true });
		} catch (error) {
			console.error("Failed to stop generation:", error);
			return c.json(
				{
					error: "Failed to stop generation",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	return app;
}
