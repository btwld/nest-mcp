/** DI token for the resolved `McpResourceServerOptions`. */
export const MCP_RESOURCE_SERVER_OPTIONS = Symbol('MCP_RESOURCE_SERVER_OPTIONS');

/**
 * DI token for the bearer-token verifier used at the HTTP edge. Host apps can
 * re-provide it (or pass `verifier` to `McpAuthModule.forRoot`) to verify
 * tokens however their authorization server requires.
 */
export const MCP_BEARER_TOKEN_VERIFIER = Symbol('MCP_BEARER_TOKEN_VERIFIER');
