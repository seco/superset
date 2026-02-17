import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		STREAMS_PORT: z.coerce.number().default(8080),
		STREAMS_INTERNAL_PORT: z.coerce.number().default(8081),
		STREAMS_INTERNAL_URL: z.string().url().optional(),
		STREAMS_DATA_DIR: z.string().min(1).default("./data"),
		STREAMS_AUTH_TOKEN: z.string().optional(),
		CORS_ORIGINS: z.string().optional(),
	},
	clientPrefix: "PUBLIC_",
	client: {},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
