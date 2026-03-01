// @nest-mcp/gateway - NestJS MCP Gateway

// Module
export { McpGatewayModule } from './mcp-gateway.module';
export type { McpGatewayOptions, McpGatewayAsyncOptions } from './mcp-gateway.module';

// Gateway service
export { GatewayService } from './gateway.service';
export type { GatewayCallToolResult } from './gateway.service';
export type {
  GatewayReadResourceResult,
  GatewayGetPromptResult,
  GatewayCompleteResult,
} from './gateway.service';

// Routing
export { RouterService } from './routing/router.service';
export { ToolAggregatorService } from './routing/tool-aggregator.service';
export type { AggregatedTool, ToolInputSchema } from './routing/tool-aggregator.service';
export { ResourceAggregatorService } from './routing/resource-aggregator.service';
export type { AggregatedResource } from './routing/resource-aggregator.service';
export { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
export type { AggregatedResourceTemplate } from './routing/resource-template-aggregator.service';
export { PromptAggregatorService } from './routing/prompt-aggregator.service';
export type { AggregatedPrompt } from './routing/prompt-aggregator.service';
export type {
  RoutingConfig,
  ToolRoutingStrategy,
  ResolvedRoute,
} from './routing/route-config.interface';

// Upstream
export { UpstreamManagerService } from './upstream/upstream-manager.service';
export { HealthCheckerService } from './upstream/health-checker.service';
export type {
  UpstreamConfig,
  UpstreamTransportType,
  UpstreamStatus,
} from './upstream/upstream.interface';

// Policies
export { PolicyEngineService } from './policies/policy-engine.service';
export type {
  PolicyEffect,
  PolicyRule,
  PolicyContext,
  PoliciesConfig,
  PolicyEvaluationResult,
} from './policies/policy.interface';

// Cache
export { ResponseCacheService } from './cache/response-cache.service';
export type {
  CacheConfig,
  CacheRule,
  CacheEntry,
} from './cache/cache.interface';

// Transform
export { RequestTransformService } from './transform/request-transform.service';
export type {
  RequestTransformFn,
  ToolCallRequest,
} from './transform/request-transform.service';
export { ResponseTransformService } from './transform/response-transform.service';
export type {
  ResponseTransformFn,
  ToolCallResponse,
} from './transform/response-transform.service';

// Tasks
export { TaskAggregatorService } from './task/task-aggregator.service';

// Utils
export { matchGlobPattern } from './utils/pattern-matcher';
export { collectFulfilled } from './utils/settled-results';

// Re-export everything from @nest-mcp/common for convenience —
// users only need to install @nest-mcp/gateway
export * from '@nest-mcp/common';
