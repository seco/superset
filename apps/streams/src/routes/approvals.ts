import { Hono } from "hono";
import { z } from "zod";
import type { SessionProtocol } from "../protocol";

const approvalBodySchema = z.object({
	approved: z.boolean(),
	txid: z.string().optional(),
});

export function createApprovalRoutes(protocol: SessionProtocol) {
	const app = new Hono();

	app.post("/:sessionId/approvals/:approvalId", async (c) => {
		const sessionId = c.req.param("sessionId");
		const approvalId = c.req.param("approvalId");

		let body: z.infer<typeof approvalBodySchema>;
		try {
			const rawBody = await c.req.json();
			body = approvalBodySchema.parse(rawBody);
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
			const actorId = c.req.header("X-Actor-Id") ?? crypto.randomUUID();

			await protocol.getOrCreateSession(sessionId);
			await protocol.writeApprovalResponse(
				sessionId,
				actorId,
				approvalId,
				body.approved,
				body.txid,
			);

			return c.json({ ok: true });
		} catch (error) {
			console.error("Failed to respond to approval:", error);
			return c.json(
				{
					error: "Failed to respond to approval",
					details: (error as Error).message,
				},
				500,
			);
		}
	});

	return app;
}
