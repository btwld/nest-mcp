import type { McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import type { McpFetchHandler } from "../auth/mcp-resource-server.ts";
import { hardenMcpFetch, resolveMcpHttpSecurity } from "./mcp-http-security.ts";
import type { McpCorsOptions, McpHttpSecurityPolicy } from "./mcp-http-security.ts";

export interface McpRequestValidationOptions {
	/** Hostnames only; do not include ports or schemes. */
	readonly allowedHostnames: readonly string[];
	/** Origin hostnames only. A missing Origin header is accepted by the official validator. */
	readonly allowedOriginHostnames: readonly string[];
	/** CORS handling for admitted origins; defaults to on (origin validation is always on here). */
	readonly cors?: McpCorsOptions | boolean;
	/** Request-body byte cap; defaults to 1 MiB, matching the runtime. `false` disables it. */
	readonly maxBodyBytes?: number | false;
}

/**
 * Explicit Host and Origin validation ahead of an MCP fetch handler. This
 * facade owns the full pre-dispatch posture — host/origin validation, the body
 * cap, and CORS decoration — so composing it never silently drops the runtime's
 * default protections for the requests it admits.
 */
export class McpValidatedServer implements McpFetchHandler {
	readonly notify: McpFetchHandler["notify"];
	readonly bus: McpFetchHandler["bus"];

	readonly #handler: McpFetchHandler;
	readonly #policy: McpHttpSecurityPolicy;
	readonly #hardened: ReturnType<typeof hardenMcpFetch>;

	constructor(handler: McpFetchHandler, options: McpRequestValidationOptions) {
		this.#handler = handler;
		// Keep the historical non-empty-allowlist contract, then delegate to the
		// shared hardened pipeline for the actual gating.
		const allowedHostnames = normalizeAllowlist(options.allowedHostnames, "allowedHostnames");
		const allowedOriginHostnames = normalizeAllowlist(
			options.allowedOriginHostnames,
			"allowedOriginHostnames",
		);
		this.#policy = resolveMcpHttpSecurity({
			allowedHostnames,
			allowedOriginHostnames,
			...(options.cors === undefined ? {} : { cors: options.cors }),
			...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
		});
		this.#hardened = hardenMcpFetch(handler, this.#policy);
		this.notify = handler.notify;
		this.bus = handler.bus;
	}

	get policy(): McpHttpSecurityPolicy {
		return this.#policy;
	}

	fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		return this.#hardened.fetch(request, options);
	}

	close(): Promise<void> {
		return this.#handler.close();
	}
}

function normalizeAllowlist(values: readonly string[], field: string): string[] {
	if (values.length === 0) throw new TypeError(`${field} cannot be empty.`);
	return values.map((value, index) => {
		const normalized = value.trim().toLowerCase();
		if (normalized.length === 0) {
			throw new TypeError(`${field}[${String(index)}] cannot be empty.`);
		}
		if (normalized.includes("://") || normalized.includes("/")) {
			throw new TypeError(
				`${field}[${String(index)}] must be a hostname without a scheme or path.`,
			);
		}
		return normalized;
	});
}
