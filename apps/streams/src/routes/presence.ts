import { Hono } from "hono";
import { z } from "zod";
import type { SessionProtocol } from "../protocol";

const loginSchema = z.object({
	userId: z.string(),
	deviceId: z.string(),
	name: z.string().optional(),
	status: z.enum(["active", "idle", "typing", "offline"]).optional(),
});

const logoutSchema = z.object({
	userId: z.string(),
	deviceId: z.string(),
});

export function createPresenceRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.post("/:sessionId/login", async (c) => {
		const sessionId = c.req.param("sessionId");

		let body: z.infer<typeof loginSchema>;
		try {
			const rawBody = await c.req.json();
			body = loginSchema.parse(rawBody);
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
			await protocol.getOrCreateSession(sessionId);
			await protocol.writePresence(
				sessionId,
				body.userId,
				body.deviceId,
				body.status ?? "active",
				body.name,
			);

			return c.json({ ok: true });
		} catch (error) {
			console.error("Failed to login:", error);
			return c.json(
				{ error: "Failed to login", details: (error as Error).message },
				500,
			);
		}
	});

	app.post("/:sessionId/logout", async (c) => {
		const sessionId = c.req.param("sessionId");

		let body: z.infer<typeof logoutSchema>;
		try {
			const rawBody = await c.req.json();
			body = logoutSchema.parse(rawBody);
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
			const stream = protocol.getSession(sessionId);
			if (!stream) {
				return c.json({ error: "Session not found" }, 404);
			}

			await protocol.writePresence(
				sessionId,
				body.userId,
				body.deviceId,
				"offline",
			);

			return c.json({ ok: true });
		} catch (error) {
			console.error("Failed to logout:", error);
			return c.json(
				{ error: "Failed to logout", details: (error as Error).message },
				500,
			);
		}
	});

	return app;
}
