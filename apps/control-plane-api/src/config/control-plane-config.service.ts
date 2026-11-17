import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";

const booleanString = z
	.enum(["true", "false"])
	.default("true")
	.transform((value) => value === "true");

const hostList = z.string().transform((value) =>
	Object.freeze(
		value
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index),
	),
);

const loopbackOrHttpsUrl = z
	.string()
	.url()
	.transform((value, context) => {
		const url = new URL(value);
		if (
			url.username.length > 0 ||
			url.password.length > 0 ||
			url.hash.length > 0 ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
		) {
			context.addIssue({ code: "custom", message: "URL must use HTTPS or loopback HTTP." });
			return z.NEVER;
		}
		return url.href;
	});

const environmentSchema = z
	.object({
		CONTROL_PLANE_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
		CONTROL_PLANE_PORT: z.coerce.number().int().min(1).max(65_535).default(3400),
		MCP_ALLOWED_HOSTS: z
			.string()
			.default("127.0.0.1,localhost,::1")
			.pipe(hostList)
			.refine((value) => value.length > 0, "MCP_ALLOWED_HOSTS must contain at least one host."),
		MCP_OAUTH_ALLOWED_HOSTS: z
			.string()
			.default("127.0.0.1,localhost,::1")
			.pipe(hostList)
			.refine(
				(value) => value.length > 0,
				"MCP_OAUTH_ALLOWED_HOSTS must contain at least one host.",
			),
		CONTROL_PLANE_UI_ORIGIN: loopbackOrHttpsUrl.default("http://127.0.0.1:5173"),
		CONTROL_PLANE_OAUTH_CALLBACK_URL: loopbackOrHttpsUrl.default(
			"http://127.0.0.1:5173/api/v1/mcp/oauth/callback",
		),
		MCP_OAUTH_TRANSACTION_TTL_MS: z.coerce
			.number()
			.int()
			.min(60_000)
			.max(60 * 60 * 1_000)
			.default(10 * 60 * 1_000),
		MCP_ALLOW_LOOPBACK_HTTP: booleanString,
		MCP_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(1_000).default(16),
		MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
		MCP_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
		MCP_MAX_DISCOVERY_PAGES: z.coerce.number().int().min(1).max(64).default(16),
		MCP_MAX_DISCOVERY_ITEMS: z.coerce.number().int().min(1).max(10_000).default(1_000),
	})
	.readonly();

export type ControlPlaneEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(values: Record<string, unknown>): Record<string, unknown> {
	return environmentSchema.parse(values);
}

@Injectable()
export class ControlPlaneConfigService {
	constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

	get host(): ControlPlaneEnvironment["CONTROL_PLANE_HOST"] {
		return this.config.getOrThrow<ControlPlaneEnvironment["CONTROL_PLANE_HOST"]>(
			"CONTROL_PLANE_HOST",
		);
	}

	get port(): number {
		return this.config.getOrThrow<number>("CONTROL_PLANE_PORT");
	}

	get allowedHosts(): readonly string[] {
		return this.config.getOrThrow<readonly string[]>("MCP_ALLOWED_HOSTS");
	}

	get allowLoopbackHttp(): boolean {
		return this.config.getOrThrow<boolean>("MCP_ALLOW_LOOPBACK_HTTP");
	}

	get oauthAllowedHosts(): readonly string[] {
		return this.config.getOrThrow<readonly string[]>("MCP_OAUTH_ALLOWED_HOSTS");
	}

	get uiOrigin(): string {
		return this.config.getOrThrow<string>("CONTROL_PLANE_UI_ORIGIN");
	}

	get oauthCallbackUrl(): string {
		return this.config.getOrThrow<string>("CONTROL_PLANE_OAUTH_CALLBACK_URL");
	}

	get oauthTransactionTtlMs(): number {
		return this.config.getOrThrow<number>("MCP_OAUTH_TRANSACTION_TTL_MS");
	}

	get maxConnections(): number {
		return this.config.getOrThrow<number>("MCP_MAX_CONNECTIONS");
	}

	get requestTimeoutMs(): number {
		return this.config.getOrThrow<number>("MCP_REQUEST_TIMEOUT_MS");
	}

	get shutdownTimeoutMs(): number {
		return this.config.getOrThrow<number>("MCP_SHUTDOWN_TIMEOUT_MS");
	}

	get maxDiscoveryPages(): number {
		return this.config.getOrThrow<number>("MCP_MAX_DISCOVERY_PAGES");
	}

	get maxDiscoveryItems(): number {
		return this.config.getOrThrow<number>("MCP_MAX_DISCOVERY_ITEMS");
	}
}

function isLoopbackHostname(value: string): boolean {
	const hostname = value.trim().toLowerCase();
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
