// JSON-RPC 2.0 standard error codes
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// MCP-specific error codes
export const MCP_URL_ELICITATION_REQUIRED = -32042;

// Application-level error codes
export const MCP_TOOL_NOT_FOUND = 1001;
export const MCP_RESOURCE_NOT_FOUND = 1002;
export const MCP_PROMPT_NOT_FOUND = 1003;
export const MCP_VALIDATION_ERROR = 1004;
export const MCP_AUTHENTICATION_ERROR = 1005;
export const MCP_AUTHORIZATION_ERROR = 1006;
export const MCP_RATE_LIMIT_EXCEEDED = 1007;
export const MCP_CIRCUIT_OPEN = 1008;
export const MCP_SESSION_EXPIRED = 1009;
export const MCP_TRANSPORT_ERROR = 1010;
