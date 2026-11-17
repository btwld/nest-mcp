export { McpValidatedServer } from "./mcp-request-validation.ts";
export type { McpRequestValidationOptions } from "./mcp-request-validation.ts";

export {
	applyMcpCorsHeaders,
	corsAllowedOrigin,
	hardenMcpFetch,
	isMcpHttpSecurityPolicy,
	limitMcpRequestBody,
	MCP_CORS_ALLOWED_HEADERS,
	MCP_CORS_EXPOSED_HEADERS,
	MCP_CORS_METHODS,
	MCP_DEFAULT_MAX_BODY_BYTES,
	McpHardenedServer,
	mcpHttpSecurityRejection,
	resolveMcpHttpSecurity,
} from "./mcp-http-security.ts";
export type {
	McpCorsOptions,
	McpHardenHooks,
	McpHttpSecurityOptions,
	McpHttpSecurityPolicy,
} from "./mcp-http-security.ts";
export { withMcpNodeBodyLimit } from "./mcp-node-body-limit.ts";
export type { McpNodeBodyLimit } from "./mcp-node-body-limit.ts";

export {
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
	validateHostHeader,
	validateOriginHeader,
} from "@modelcontextprotocol/server";
export type {
	HostHeaderValidationResult,
	OriginValidationResult,
} from "@modelcontextprotocol/server";
