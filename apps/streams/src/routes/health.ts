import { Hono } from "hono";

export function createHealthRoutes() {
	const app = new Hono();

	app.get("/", (c) => {
		return c.json({ status: "ok" });
	});

	app.get("/ready", (c) => {
		return c.json({ ready: true });
	});

	return app;
}
