import {
	MCP_CORS_ALLOWED_HEADERS,
	MCP_CORS_EXPOSED_HEADERS,
	MCP_CORS_METHODS,
} from "@nest-mcp/server/security";

const DEFAULT_MAX_AGE_SECONDS = 600;

export interface McpCorsInput {
	/** Full browser origins (`https://app.example.com`), not bare hostnames. */
	readonly origins: readonly string[];
	/** Allows cookies/credentialed requests. Cookie-authenticated MCP endpoints are CSRF-able; leave off unless required. */
	readonly credentials?: boolean;
	readonly maxAgeSeconds?: number;
	readonly additionalAllowedHeaders?: readonly string[];
	readonly additionalExposedHeaders?: readonly string[];
}

/**
 * Structurally compatible with Nest's `CorsOptions` for `app.enableCors()`.
 * Arrays are mutable because Nest's own option types require `string[]`.
 */
export interface McpNestCorsOptions {
	origin: string[];
	methods: string[];
	allowedHeaders: string[];
	exposedHeaders: string[];
	credentials: boolean;
	maxAge: number;
}

/**
 * CORS options preconfigured for the 2026-07-28 MCP revision, whose
 * `Mcp-Method`/`Mcp-Name` request headers make every browser MCP POST
 * CORS-preflighted. Pass the result to `app.enableCors()` when Nest owns CORS
 * for the whole app; keep exactly one CORS owner per route — with
 * `app.enableCors()` active, the runtime's built-in `httpSecurity.cors`
 * preflight handling never runs, so disable one of the two.
 */
export function mcpCorsOptions(input: McpCorsInput): McpNestCorsOptions {
	if (typeof input !== "object" || input === null || !Array.isArray(input.origins)) {
		throw new TypeError("mcpCorsOptions requires an origins array of full browser origins.");
	}
	const origins = input.origins.map((value, index) => {
		const failure = `mcpCorsOptions origins[${String(index)}] must be a full origin like "https://app.example.com".`;
		if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(failure);
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			throw new TypeError(failure);
		}
		if (parsed.origin === "null" || parsed.origin !== value.replace(/\/$/, "")) {
			throw new TypeError(failure);
		}
		return parsed.origin;
	});
	const maxAge = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
	if (!Number.isInteger(maxAge) || maxAge < 0) {
		throw new TypeError("mcpCorsOptions maxAgeSeconds must be a non-negative integer.");
	}
	return {
		origin: origins,
		methods: [...MCP_CORS_METHODS],
		allowedHeaders: mergeHeaders(MCP_CORS_ALLOWED_HEADERS, input.additionalAllowedHeaders),
		exposedHeaders: mergeHeaders(MCP_CORS_EXPOSED_HEADERS, input.additionalExposedHeaders),
		credentials: input.credentials === true,
		maxAge,
	};
}

function mergeHeaders(base: readonly string[], additional?: readonly string[]): string[] {
	const merged = new Set(base);
	for (const header of additional ?? []) {
		if (typeof header !== "string" || header.trim().length === 0) {
			throw new TypeError("mcpCorsOptions header names must be non-empty strings.");
		}
		merged.add(header.trim().toLowerCase());
	}
	return [...merged];
}
