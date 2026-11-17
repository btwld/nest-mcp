import { createMcpPassthroughMiddleware } from "@nest-mcp/core";

import type {
	McpHandlerInvocationInput,
	McpHandlerInvocationOutput,
	McpHandlerMiddleware,
	McpHandlerOperationContext,
	McpHandlerPassthroughMiddleware,
} from "./mcp.types.ts";

/**
 * Creates handler middleware that can observe the validated invocation while
 * preserving the exact SDK result produced by the downstream capability.
 */
export function createMcpHandlerPassthroughMiddleware(
	middleware: McpHandlerPassthroughMiddleware,
): McpHandlerMiddleware {
	return createMcpPassthroughMiddleware<
		McpHandlerInvocationInput,
		McpHandlerInvocationOutput,
		McpHandlerOperationContext
	>(middleware);
}
