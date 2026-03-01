import type { Root } from '@modelcontextprotocol/sdk/types.js';
import { MCP_GATEWAY_OPTIONS, McpTransportType } from '@nest-mcp/common';
import type {
  McpExecutionContext,
  McpModuleOptions,
  ToolContent,
  TransportOptions,
} from '@nest-mcp/common';
import {
  McpModule,
  McpPromptBuilder,
  McpRegistryService,
  McpResourceBuilder,
  McpToolBuilder,
} from '@nest-mcp/server';
import type { RegisteredResourceTemplate } from '@nest-mcp/server';
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { HealthCheckerService } from './upstream/health-checker.service';
// Upstream
import { UpstreamManagerService } from './upstream/upstream-manager.service';
import type { UpstreamConfig } from './upstream/upstream.interface';

import { PromptAggregatorService } from './routing/prompt-aggregator.service';
import { ResourceAggregatorService } from './routing/resource-aggregator.service';
import { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
import type { RoutingConfig } from './routing/route-config.interface';
// Routing
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';

// Tasks
import { TaskAggregatorService } from './task/task-aggregator.service';

// Policies
import { PolicyEngineService } from './policies/policy-engine.service';
import type { PoliciesConfig } from './policies/policy.interface';

import type { CacheConfig } from './cache/cache.interface';
// Cache
import { ResponseCacheService } from './cache/response-cache.service';

// Transform
import { RequestTransformService } from './transform/request-transform.service';
import { ResponseTransformService } from './transform/response-transform.service';

// Gateway
import { GatewayService } from './gateway.service';

export interface McpGatewayOptions {
  server: McpModuleOptions;
  upstreams: UpstreamConfig[];
  routing?: RoutingConfig;
  policies?: PoliciesConfig;
  cache?: CacheConfig;
  /** Roots advertised to upstream servers when they request roots/list. */
  roots?: Root[];
}

export interface McpGatewayAsyncOptions {
  // biome-ignore lint/suspicious/noExplicitAny: NestJS DynamicModule requires broad module types
  imports?: any[];
  server: { transport: McpTransportType | McpTransportType[]; transportOptions?: TransportOptions };
  // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
  useFactory: (...args: any[]) => McpGatewayOptions | Promise<McpGatewayOptions>;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens have broad types
  inject?: any[];
}

@Module({})
export class McpGatewayModule implements OnApplicationBootstrap {
  private static readonly logger = new Logger('McpGatewayModule');

  constructor(
    @Inject(MCP_GATEWAY_OPTIONS)
    private readonly options: McpGatewayOptions,
    private readonly gatewayService: GatewayService,
    private readonly upstreamManager: UpstreamManagerService,
    private readonly healthChecker: HealthCheckerService,
    private readonly router: RouterService,
    private readonly policyEngine: PolicyEngineService,
    private readonly responseCache: ResponseCacheService,
    private readonly toolBuilder: McpToolBuilder,
    private readonly resourceBuilder: McpResourceBuilder,
    private readonly promptBuilder: McpPromptBuilder,
    private readonly resourceAggregator: ResourceAggregatorService,
    private readonly promptAggregator: PromptAggregatorService,
    private readonly resourceTemplateAggregator: ResourceTemplateAggregatorService,
    private readonly registry: McpRegistryService,
    private readonly taskAggregator: TaskAggregatorService,
  ) {}

  static forRoot(options: McpGatewayOptions): DynamicModule {
    const serverOptions: McpModuleOptions = {
      ...options.server,
      transport: options.server.transport ?? McpTransportType.STREAMABLE_HTTP,
      // Always enable tasks capability so the gateway can proxy task requests from downstream
      capabilities: { ...options.server.capabilities, tasks: { enabled: true } },
    };

    return {
      module: McpGatewayModule,
      imports: [McpModule.forRoot(serverOptions)],
      providers: [
        { provide: MCP_GATEWAY_OPTIONS, useValue: options },
        UpstreamManagerService,
        HealthCheckerService,
        RouterService,
        ToolAggregatorService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        GatewayService,
        ResourceAggregatorService,
        PromptAggregatorService,
        ResourceTemplateAggregatorService,
        TaskAggregatorService,
      ],
      exports: [
        GatewayService,
        UpstreamManagerService,
        HealthCheckerService,
        RouterService,
        ToolAggregatorService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        ResourceAggregatorService,
        PromptAggregatorService,
        ResourceTemplateAggregatorService,
        TaskAggregatorService,
        MCP_GATEWAY_OPTIONS,
      ],
    };
  }

  static forRootAsync(options: McpGatewayAsyncOptions): DynamicModule {
    const asyncOptionsProvider = {
      provide: MCP_GATEWAY_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    return {
      module: McpGatewayModule,
      imports: [
        ...(options.imports ?? []),
        McpModule.forRootAsync({
          transport: options.server.transport,
          transportOptions: options.server.transportOptions,
          // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
          useFactory: async (...args: any[]) => {
            const gatewayOpts = await options.useFactory(...args);
            // Always enable tasks capability so the gateway can proxy task requests
            return {
              ...gatewayOpts.server,
              capabilities: { ...gatewayOpts.server.capabilities, tasks: { enabled: true } },
            };
          },
          inject: options.inject ?? [],
        }),
      ],
      providers: [
        asyncOptionsProvider,
        UpstreamManagerService,
        HealthCheckerService,
        RouterService,
        ToolAggregatorService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        GatewayService,
        ResourceAggregatorService,
        PromptAggregatorService,
        ResourceTemplateAggregatorService,
        TaskAggregatorService,
      ],
      exports: [
        GatewayService,
        UpstreamManagerService,
        HealthCheckerService,
        RouterService,
        ToolAggregatorService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        ResourceAggregatorService,
        PromptAggregatorService,
        ResourceTemplateAggregatorService,
        TaskAggregatorService,
        MCP_GATEWAY_OPTIONS,
      ],
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    // Configure routing
    this.router.configure(
      this.options.upstreams,
      this.options.routing ?? { toolRouting: 'prefix', aggregateToolLists: true },
    );

    // Configure policies
    this.policyEngine.configure(this.options.policies ?? { defaultEffect: 'allow', rules: [] });

    // Configure cache
    this.responseCache.configure(this.options.cache ?? { enabled: false, defaultTtl: 60000 });

    // Connect to all upstreams, passing roots so they are advertised during handshake
    await this.upstreamManager.connectAll(this.options.upstreams, this.options.roots);

    // Start health checks
    this.healthChecker.startAll(this.options.upstreams);

    // Register task proxy handlers so downstream clients can poll/cancel upstream tasks
    this.registry.registerTaskHandlers({
      listTasks: (cursor) => this.taskAggregator.listTasks(cursor),
      getTask: (taskId) => this.taskAggregator.getTask(taskId),
      cancelTask: (taskId) => this.taskAggregator.cancelTask(taskId),
      getTaskPayload: (taskId) => this.taskAggregator.getTaskPayload(taskId),
    });

    // Aggregate tools and register them as dynamic tools on the MCP server
    await this.registerUpstreamTools();

    // Aggregate resources and register them on the MCP server
    await this.registerUpstreamResources();

    // Aggregate prompts and register them on the MCP server
    await this.registerUpstreamPrompts();

    // Aggregate resource templates and register them on the MCP server
    await this.registerUpstreamResourceTemplates();

    // Register completion handlers for prompts and resource templates
    this.registerCompletionHandlers();

    McpGatewayModule.logger.log('MCP Gateway initialized');
  }

  private async registerUpstreamTools(): Promise<void> {
    const tools = await this.gatewayService.listTools();

    for (const tool of tools) {
      this.toolBuilder.register({
        name: tool.name,
        description: tool.description ?? `Proxied tool from ${tool.upstreamName}`,
        inputSchema: tool.inputSchema,
        rawOutputSchema: tool.outputSchema,
        annotations: tool.annotations,
        handler: async (args: Record<string, unknown>, ctx: McpExecutionContext) => {
          const result = await this.gatewayService.callTool(
            tool.name,
            args,
            undefined,
            ctx.signal,
            ctx.createMessage,
            ctx.elicit,
          );
          return {
            content: result.content as ToolContent[],
            isError: result.isError,
          };
        },
      });
    }

    McpGatewayModule.logger.log(`Registered ${tools.length} upstream tools`);
  }

  private async registerUpstreamResources(): Promise<void> {
    const resources = await this.gatewayService.listResources();

    for (const resource of resources) {
      this.resourceBuilder.register({
        uri: resource.uri,
        name: resource.name,
        description: resource.description ?? `Proxied resource from ${resource.upstreamName}`,
        mimeType: resource.mimeType,
        handler: async (_uri: URL, ctx: McpExecutionContext) => {
          const result = await this.gatewayService.readResource(resource.uri, ctx.signal);
          return { contents: result.contents } as {
            contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
          };
        },
      });
    }

    McpGatewayModule.logger.log(`Registered ${resources.length} upstream resources`);
  }

  private async registerUpstreamPrompts(): Promise<void> {
    const prompts = await this.gatewayService.listPrompts();

    for (const prompt of prompts) {
      this.promptBuilder.register({
        name: prompt.name,
        description: prompt.description ?? `Proxied prompt from ${prompt.upstreamName}`,
        handler: async (args: Record<string, unknown>, ctx: McpExecutionContext) => {
          const stringArgs = Object.fromEntries(
            Object.entries(args).map(([key, value]) => [key, String(value)]),
          );
          const result = await this.gatewayService.getPrompt(prompt.name, stringArgs, ctx.signal);
          return result as {
            description?: string;
            messages: Array<{
              role: 'user' | 'assistant';
              content: { type: 'text'; text: string };
            }>;
          };
        },
      });
    }

    McpGatewayModule.logger.log(`Registered ${prompts.length} upstream prompts`);
  }

  private async registerUpstreamResourceTemplates(): Promise<void> {
    const templates = await this.gatewayService.listResourceTemplates();

    for (const template of templates) {
      const handlerWrapper = {
        [template.name]: async (
          uri: URL,
          _params: Record<string, string>,
          ctx: McpExecutionContext,
        ) => {
          return this.gatewayService.readResourceTemplate(uri.href, ctx.signal);
        },
      };

      const registered: RegisteredResourceTemplate = {
        uriTemplate: template.uriTemplate,
        name: template.name,
        description:
          template.description ?? `Proxied resource template from ${template.upstreamName}`,
        mimeType: template.mimeType,
        methodName: template.name,
        target: handlerWrapper.constructor as abstract new (...args: unknown[]) => unknown,
        instance: handlerWrapper,
      };

      this.registry.registerResourceTemplate(registered);
    }

    McpGatewayModule.logger.log(`Registered ${templates.length} upstream resource templates`);
  }

  private registerCompletionHandlers(): void {
    const prompts = this.gatewayService.getCachedPrompts();
    const templates = this.gatewayService.getCachedResourceTemplates();
    let count = 0;

    for (const prompt of prompts) {
      const handlerObj = {
        complete: async (argName: string, argValue: string) => {
          return this.gatewayService.complete(
            { type: 'ref/prompt', name: prompt.name },
            { name: argName, value: argValue },
          );
        },
      };

      this.registry.registerCompletionHandler({
        refType: 'ref/prompt',
        refName: prompt.name,
        methodName: 'complete',
        instance: handlerObj,
      });
      count++;
    }

    for (const template of templates) {
      const handlerObj = {
        complete: async (argName: string, argValue: string) => {
          return this.gatewayService.complete(
            { type: 'ref/resource', uri: template.uriTemplate },
            { name: argName, value: argValue },
          );
        },
      };

      this.registry.registerCompletionHandler({
        refType: 'ref/resource',
        refName: template.uriTemplate,
        methodName: 'complete',
        instance: handlerObj,
      });
      count++;
    }

    McpGatewayModule.logger.log(`Registered ${count} completion handlers`);
  }
}
