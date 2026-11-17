import type { McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import type { McpServerRuntime } from "../mcp-server.runtime.ts";

/** Create a fetch implementation that routes requests directly into a runtime without a socket. */
export function createMcpServerTestFetch(
	runtime: Pick<McpServerRuntime, "fetch">,
	options?: McpHandlerRequestOptions,
): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		return runtime.fetch(request, options);
	};
}
