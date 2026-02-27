// @btwld/mcp-server - NestJS MCP Server

// Module
export { McpModule } from './mcp.module';

// Decorators
export {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  Completion,
  Public,
  Scopes,
  Roles,
  Guards,
  UseMiddleware,
  RateLimit,
  Retry,
  CircuitBreaker,
  Timeout,
} from './decorators';

// Discovery
export { McpRegistryService } from './discovery/registry.service';
export type {
  RegisteredTool,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredPrompt,
  RegisteredCompletion,
} from './discovery/registry.service';
export type { CompletionOptions, CompletionMetadata } from './decorators/completion.decorator';

// Execution
export { McpExecutorService } from './execution/executor.service';
export { ExecutionPipelineService } from './execution/pipeline.service';
export { McpContextFactory } from './execution/context.factory';
export { McpRequestContextService } from './execution/request-context.service';

// Transport
export { StreamableHttpService } from './transport/streamable-http/streamable.service';
export { SseService } from './transport/sse/sse.service';
export { StdioService } from './transport/stdio/stdio.service';
export { StderrLogger } from './transport/stdio/stderr-logger';
export { bootstrapStdioApp } from './transport/stdio/bootstrap-stdio';
export type { StdioBootstrapOptions } from './transport/stdio/bootstrap-stdio';

// Resilience
export { RateLimiterService } from './resilience/rate-limiter.service';
export { CircuitBreakerService } from './resilience/circuit-breaker.service';
export { RetryService } from './resilience/retry.service';

// Middleware
export { MiddlewareService } from './middleware/middleware.service';

// Auth
export { ToolAuthGuardService } from './auth/guards/tool-auth.guard';
export { McpAuthModule } from './auth/auth.module';
export { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
export { AuthRateLimitGuard } from './auth/guards/auth-rate-limit.guard';
export { AuthAuditService } from './auth/services/auth-audit.service';
export type { AuditLogEntry } from './auth/services/auth-audit.service';
export { JwtTokenService, MCP_AUTH_OPTIONS } from './auth/services/jwt-token.service';
export { OAuthClientService, MCP_OAUTH_STORE } from './auth/services/client.service';
export { MemoryOAuthStore } from './auth/stores/memory-store.service';
export type { IOAuthStore } from './auth/stores/oauth-store.interface';
export type { McpAuthModuleOptions } from './auth/interfaces/auth-module-options.interface';
export type { OAuthProviderAdapter, OAuthProviderUser } from './auth/interfaces/oauth-provider.interface';
export type {
  OAuthClient,
  AuthorizationCode,
  TokenPayload,
  TokenResponse,
  TokenIntrospectionResponse,
} from './auth/interfaces/oauth-types.interface';

// Session
export { SessionManager } from './session/session.manager';

// Subscription
export { ResourceSubscriptionManager } from './subscription/resource-subscription.manager';
export type { McpSession } from './session/session.manager';

// Tasks
export { TaskManager } from './task/task.manager';

// Dynamic builders
export { McpToolBuilder } from './dynamic/tool-builder.service';
export type { DynamicToolConfig } from './dynamic/tool-builder.service';
export { McpResourceBuilder } from './dynamic/resource-builder.service';
export type { DynamicResourceConfig } from './dynamic/resource-builder.service';
export { McpPromptBuilder } from './dynamic/prompt-builder.service';
export type { DynamicPromptConfig } from './dynamic/prompt-builder.service';

// Observability
export { MetricsService } from './observability/metrics.service';
export type { ToolMetrics } from './observability/metrics.service';

// Server factory
export { createMcpServer } from './server/server.factory';

// Re-export common types for convenience
export type {
  McpModuleOptions,
  McpModuleAsyncOptions,
  McpExecutionContext,
  McpMiddleware,
  ToolOptions,
  ToolMetadata,
  ToolCallResult,
  ResourceOptions,
  ResourceMetadata,
  ResourceTemplateOptions,
  ResourceTemplateMetadata,
  PromptOptions,
  PromptMetadata,
  PromptGetResult,
  RateLimitConfig,
  RetryConfig,
  CircuitBreakerConfig,
  McpGuard,
  McpGuardContext,
  AuthenticatedUser,
  CompletionRequest,
  CompletionResult,
  CompletionHandler,
} from '@btwld/mcp-common';

export { McpTransportType } from '@btwld/mcp-common';
