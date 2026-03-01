// @nest-mcp/client - NestJS MCP Client

// Module
export { McpClientModule, McpClientBootstrap } from './mcp-client.module';

// Service
export { McpClient } from './mcp-client.service';
export { McpClientsService } from './mcp-clients.service';

// Decorators
export { InjectMcpClient, getMcpClientToken } from './decorators/inject-mcp-client.decorator';
export {
  OnMcpNotification,
  MCP_NOTIFICATION_METADATA,
} from './decorators/on-notification.decorator';
export type { McpNotificationMetadata } from './decorators/on-notification.decorator';

// Interfaces
export type {
  McpClientModuleOptions,
  McpClientModuleAsyncOptions,
  McpClientConnection,
  McpClientHttpConnectionBase,
  McpClientStreamableHttpConnection,
  McpClientSseConnection,
  McpClientStdioConnection,
  McpClientReconnectOptions,
  McpClientAuthOptions,
  McpClientTransportType,
  McpSamplingHandler,
  McpElicitationHandler,
  McpRootsHandler,
} from './interfaces/client-options.interface';

// Transport
export { createClientTransport } from './transport/client-transport.factory';
export { createStreamableHttpTransport } from './transport/streamable-client.transport';
export { createSseTransport } from './transport/sse-client.transport';
export { createStdioTransport } from './transport/stdio-client.transport';
export { applyAuthHeaders } from './transport/apply-auth-headers';

// Utilities
export { formatErrorMessage } from './utils/format-error-message';

// Health
export { McpClientHealthIndicator } from './health/mcp-client.health';
export type {
  McpClientHealthStatus,
  McpClientHealthResult,
} from './health/mcp-client.health';

// Testing
export { MockMcpClient } from './testing/mock-client';

// OAuth
export {
  auth,
  extractWWWAuthenticateParams,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
export type {
  OAuthClientProvider,
  AuthResult,
} from '@modelcontextprotocol/sdk/client/auth.js';
export type {
  OAuthClientMetadata,
  OAuthTokens,
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
