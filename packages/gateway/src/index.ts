// @btwld/mcp-gateway - NestJS MCP Gateway

// Module
export { McpGatewayModule } from './mcp-gateway.module';
export type { McpGatewayOptions } from './mcp-gateway.module';

// Gateway service
export { GatewayService } from './gateway.service';
export type { GatewayCallToolResult } from './gateway.service';

// Routing
export { RouterService } from './routing/router.service';
export { ToolAggregatorService } from './routing/tool-aggregator.service';
export type { AggregatedTool } from './routing/tool-aggregator.service';
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
