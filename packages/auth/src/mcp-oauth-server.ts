import type { McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import type { McpFetchHandler } from "@nest-mcp/server/auth";
import { createMcpOAuthRouter } from "./mcp-oauth-router.ts";
import type { McpOAuthRouter } from "./mcp-oauth-router.ts";
import type { McpOAuthProxy } from "./proxy/mcp-oauth-proxy.ts";

export interface McpOAuthServerOptions {
	readonly proxy: McpOAuthProxy;
	readonly basePath?: string;
	readonly maxBodyBytes?: number;
}

/**
 * Fetch-handler facade that answers the proxy's OAuth authorization-server
 * routes and delegates everything else to the wrapped MCP handler. The OAuth
 * endpoints are unauthenticated by definition, so this must sit inside any
 * host/origin validation but outside the resource-server bearer gate.
 */
export class McpOAuthServer implements McpFetchHandler {
	readonly notify: McpFetchHandler["notify"];
	readonly bus: McpFetchHandler["bus"];

	readonly #handler: McpFetchHandler;
	readonly #router: McpOAuthRouter;

	constructor(handler: McpFetchHandler, options: McpOAuthServerOptions) {
		this.#handler = handler;
		this.#router = createMcpOAuthRouter({
			proxy: options.proxy,
			...(options.basePath === undefined ? {} : { basePath: options.basePath }),
			...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
		});
		this.notify = handler.notify;
		this.bus = handler.bus;
	}

	async fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		const handled = await this.#router(request);
		if (handled !== undefined) return handled;
		return this.#handler.fetch(request, options);
	}

	close(): Promise<void> {
		return this.#handler.close();
	}
}
