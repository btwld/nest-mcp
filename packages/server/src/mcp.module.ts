import type { McpModuleAsyncOptions, McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import {
  type DynamicModule,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Provider,
  type Type,
} from '@nestjs/common';

// Discovery
import { McpRegistryService } from './discovery/registry.service';
import { McpScannerService } from './discovery/scanner.service';

import { McpContextFactory } from './execution/context.factory';
// Execution
import { McpExecutorService } from './execution/executor.service';
import { ExecutionPipelineService } from './execution/pipeline.service';
import { McpRequestContextService } from './execution/request-context.service';

import { createSseController } from './transport/sse/sse.controller.factory';
import { SseService } from './transport/sse/sse.service';
import { StdioService } from './transport/stdio/stdio.service';
import { createStreamableHttpController } from './transport/streamable-http/streamable.controller.factory';
// Transport
import { StreamableHttpService } from './transport/streamable-http/streamable.service';

import { CircuitBreakerService } from './resilience/circuit-breaker.service';
// Resilience
import { RateLimiterService } from './resilience/rate-limiter.service';
import { RetryService } from './resilience/retry.service';

// Middleware
import { MiddlewareService } from './middleware/middleware.service';

// Auth
import { ToolAuthGuardService } from './auth/guards/tool-auth.guard';

// Session
import { SessionManager } from './session/session.manager';

// Subscription
import { ResourceSubscriptionManager } from './subscription/resource-subscription.manager';

// Tasks
import { TaskManager } from './task/task.manager';

import { McpPromptBuilder } from './dynamic/prompt-builder.service';
import { McpResourceBuilder } from './dynamic/resource-builder.service';
// Dynamic
import { McpToolBuilder } from './dynamic/tool-builder.service';

// Observability
import { MetricsService } from './observability/metrics.service';

// Server
import { createMcpServer } from './server/server.factory';

import {
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_SSE_ENDPOINT,
  DEFAULT_SSE_MESSAGES_ENDPOINT,
} from './constants/module.constants';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes
export class McpModule {
  private static readonly logger = new Logger('McpModule');

  static forRoot(options: McpModuleOptions): DynamicModule {
    const controllers: Type[] = [];
    const providers: Provider[] = [
      { provide: MCP_OPTIONS, useValue: options },
      McpRegistryService,
      McpScannerService,
      McpExecutorService,
      ExecutionPipelineService,
      McpRequestContextService,
      McpContextFactory,
      RateLimiterService,
      CircuitBreakerService,
      RetryService,
      MiddlewareService,
      ToolAuthGuardService,
      SessionManager,
      McpToolBuilder,
      McpResourceBuilder,
      McpPromptBuilder,
      MetricsService,
      ResourceSubscriptionManager,
      TaskManager,
    ];

    // Streamable HTTP transport
    if (options.transport === McpTransportType.STREAMABLE_HTTP) {
      const endpoint = options.transportOptions?.streamableHttp?.endpoint ?? DEFAULT_MCP_ENDPOINT;
      providers.push(StreamableHttpService);
      controllers.push(createStreamableHttpController(endpoint));
    }

    // SSE transport
    if (options.transport === McpTransportType.SSE) {
      const sseEndpoint = options.transportOptions?.sse?.endpoint ?? DEFAULT_SSE_ENDPOINT;
      const messagesEndpoint =
        options.transportOptions?.sse?.messagesEndpoint ?? DEFAULT_SSE_MESSAGES_ENDPOINT;
      providers.push(SseService);
      controllers.push(...createSseController(sseEndpoint, messagesEndpoint));
    }

    // STDIO transport
    if (options.transport === McpTransportType.STDIO) {
      providers.push(StdioService);
    }

    return {
      module: McpModule,
      global: true,
      controllers,
      providers,
      exports: [
        McpRegistryService,
        McpExecutorService,
        ExecutionPipelineService,
        McpRequestContextService,
        McpToolBuilder,
        McpResourceBuilder,
        McpPromptBuilder,
        MetricsService,
        SessionManager,
        ResourceSubscriptionManager,
        TaskManager,
        MCP_OPTIONS,
      ],
    };
  }

  static forRootAsync(options: McpModuleAsyncOptions): DynamicModule {
    const controllers: Type[] = [];
    const providers: Provider[] = [
      {
        provide: MCP_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      McpRegistryService,
      McpScannerService,
      McpExecutorService,
      ExecutionPipelineService,
      McpRequestContextService,
      McpContextFactory,
      RateLimiterService,
      CircuitBreakerService,
      RetryService,
      MiddlewareService,
      ToolAuthGuardService,
      SessionManager,
      McpToolBuilder,
      McpResourceBuilder,
      McpPromptBuilder,
      MetricsService,
      ResourceSubscriptionManager,
      TaskManager,
    ];

    // Streamable HTTP transport
    if (options.transport === McpTransportType.STREAMABLE_HTTP) {
      const endpoint = options.transportOptions?.streamableHttp?.endpoint ?? DEFAULT_MCP_ENDPOINT;
      providers.push(StreamableHttpService);
      controllers.push(createStreamableHttpController(endpoint));
    }

    // SSE transport
    if (options.transport === McpTransportType.SSE) {
      const sseEndpoint = options.transportOptions?.sse?.endpoint ?? DEFAULT_SSE_ENDPOINT;
      const messagesEndpoint =
        options.transportOptions?.sse?.messagesEndpoint ?? DEFAULT_SSE_MESSAGES_ENDPOINT;
      providers.push(SseService);
      controllers.push(...createSseController(sseEndpoint, messagesEndpoint));
    }

    // STDIO transport
    if (options.transport === McpTransportType.STDIO) {
      providers.push(StdioService);
    }

    return {
      module: McpModule,
      global: true,
      imports: options.imports ?? [],
      controllers,
      providers,
      exports: [
        McpRegistryService,
        McpExecutorService,
        ExecutionPipelineService,
        McpRequestContextService,
        McpToolBuilder,
        McpResourceBuilder,
        McpPromptBuilder,
        MetricsService,
        SessionManager,
        ResourceSubscriptionManager,
        TaskManager,
        MCP_OPTIONS,
      ],
    };
  }

  static forFeature(providers: Provider[]): DynamicModule {
    return {
      module: McpModule,
      providers,
      exports: providers,
    };
  }
}
