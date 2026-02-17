import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { SessionProtocol } from "./protocol";
import {
	createApprovalRoutes,
	createChunkRoutes,
	createGenerationRoutes,
	createHealthRoutes,
	createMessageRoutes,
	createPresenceRoutes,
	createSessionRoutes,
	createStopRoutes,
	createStreamRoutes,
	PROTOCOL_RESPONSE_HEADERS,
} from "./routes";

export function createServer(options: {
	baseUrl: string;
	corsOrigins?: string[];
}) {
	const app = new Hono();
	const protocol = new SessionProtocol({ baseUrl: options.baseUrl });

	const allowedOrigins = options.corsOrigins ?? null;

	app.use(
		"*",
		cors({
			origin: allowedOrigins
				? (origin) => {
						if (!origin || origin === "null") return origin ?? "*";
						return allowedOrigins.includes(origin) ? origin : "";
					}
				: "*",
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"X-Actor-Id",
				"X-Session-Id",
			],
			exposeHeaders: [...PROTOCOL_RESPONSE_HEADERS],
		}),
	);

	app.use("*", logger());

	app.route("/health", createHealthRoutes());

	if (env.STREAMS_AUTH_TOKEN) {
		const token = env.STREAMS_AUTH_TOKEN;
		app.use("/v1/*", async (c, next) => {
			const authorization = c.req.header("Authorization");
			if (!authorization?.startsWith("Bearer ")) {
				return c.json({ error: "Unauthorized" }, 401);
			}
			if (authorization.slice(7) !== token) {
				return c.json({ error: "Unauthorized" }, 401);
			}
			return next();
		});
	}

	const v1 = new Hono();
	v1.route("/sessions", createSessionRoutes(protocol));
	v1.route("/sessions", createMessageRoutes(protocol));
	v1.route("/sessions", createChunkRoutes(protocol));
	v1.route("/sessions", createGenerationRoutes(protocol));
	v1.route("/sessions", createStopRoutes(protocol));
	v1.route("/sessions", createApprovalRoutes(protocol));
	v1.route("/sessions", createPresenceRoutes(protocol));
	v1.route("/stream", createStreamRoutes(options.baseUrl));

	app.route("/v1", v1);

	app.get("/", (c) => {
		return c.json({
			name: "@superset/streams",
			version: "0.1.0",
			endpoints: {
				health: "/health",
				stream: "/v1/stream/sessions/:sessionId",
				sessions: "/v1/sessions/:sessionId",
				messages: "/v1/sessions/:sessionId/messages",
				chunks: "/v1/sessions/:sessionId/chunks",
				chunksBatch: "/v1/sessions/:sessionId/chunks/batch",
				approvals: "/v1/sessions/:sessionId/approvals/:approvalId",
				presence: "/v1/sessions/:sessionId/login",
				generationsStart: "/v1/sessions/:sessionId/generations/start",
				generationsFinish: "/v1/sessions/:sessionId/generations/finish",
				stop: "/v1/sessions/:sessionId/stop",
			},
		});
	});

	return { app, protocol };
}
