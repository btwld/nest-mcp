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
  type OnModuleDestroy,
} from '@nestjs/common';

import { HealthCheckerService } from './upstream/health-checker.service';
// Upstream
import { UpstreamManagerService } from './upstream/upstream-manager.service';
import type {
  UpstreamChangeEvent,
  UpstreamConfig,
  UpstreamListKind,
} from './upstream/upstream.interface';

import { PromptAggregatorService } from './routing/prompt-aggregator.service';
import type { AggregatedPrompt } from './routing/prompt-aggregator.service';
import { ResourceAggregatorService } from './routing/resource-aggregator.service';
import type { AggregatedResource } from './routing/resource-aggregator.service';
import { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
import type { AggregatedResourceTemplate } from './routing/resource-template-aggregator.service';
import type { RoutingConfig } from './routing/route-config.interface';
// Routing
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { AggregatedTool } from './routing/tool-aggregator.service';

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
import type { GatewayCompleteContext } from './gateway.service';
import { extractErrorMessage } from './utils/error-utils';

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
export class McpGatewayModule implements OnApplicationBootstrap, OnModuleDestroy {
  private static readonly logger = new Logger('McpGatewayModule');
  private unsubscribeUpstreamChanges?: () => void;
  /** Per-upstream chain of list re-syncs, so syncs for one upstream never interleave. */
  private readonly syncQueues = new Map<string, Promise<void>>();

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
    private readonly toolAggregator: ToolAggregatorService,
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

    // Keep the downstream catalog in sync with upstream list changes and reconnects
    this.unsubscribeUpstreamChanges = this.upstreamManager.onUpstreamChange((event) => {
      void this.enqueueSync(event);
    });

    McpGatewayModule.logger.log('MCP Gateway initialized');
  }

  onModuleDestroy(): void {
    this.unsubscribeUpstreamChanges?.();
    this.unsubscribeUpstreamChanges = undefined;
  }

  private async registerUpstreamTools(): Promise<void> {
    const tools = await this.gatewayService.listTools();
    for (const tool of tools) this.registerTool(tool);
    McpGatewayModule.logger.log(`Registered ${tools.length} upstream tools`);
  }

  private registerTool(tool: AggregatedTool): void {
    this.toolBuilder.register({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description ?? `Proxied tool from ${tool.upstreamName}`,
      inputSchema: tool.inputSchema,
      rawOutputSchema: tool.outputSchema,
      annotations: tool.annotations,
      ...(tool.icons ? { icons: tool.icons } : {}),
      ...(tool.execution ? { execution: tool.execution } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
      handler: async (args: Record<string, unknown>, ctx: McpExecutionContext) => {
        const result = await this.gatewayService.callTool(
          tool.name,
          args,
          undefined,
          ctx.signal,
          ctx.createMessage,
          ctx.elicit,
          ctx.reportProgress ? { onProgress: ctx.reportProgress } : undefined,
        );
        return {
          content: result.content as ToolContent[],
          isError: result.isError,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result._meta !== undefined ? { _meta: result._meta } : {}),
        };
      },
    });
  }

  private async registerUpstreamResources(): Promise<void> {
    const resources = await this.gatewayService.listResources();
    for (const resource of resources) this.registerResource(resource);
    McpGatewayModule.logger.log(`Registered ${resources.length} upstream resources`);
  }

  private registerResource(resource: AggregatedResource): void {
    this.resourceBuilder.register({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title !== undefined ? { title: resource.title } : {}),
      description: resource.description ?? `Proxied resource from ${resource.upstreamName}`,
      mimeType: resource.mimeType,
      ...(resource.icons ? { icons: resource.icons } : {}),
      ...(resource._meta ? { _meta: resource._meta } : {}),
      handler: async (_uri: URL, ctx: McpExecutionContext) => {
        const result = await this.gatewayService.readResource(resource.uri, ctx.signal);
        return { contents: result.contents } as {
          contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
        };
      },
    });
  }

  private async registerUpstreamPrompts(): Promise<void> {
    const prompts = await this.gatewayService.listPrompts();
    for (const prompt of prompts) this.registerPrompt(prompt);
    McpGatewayModule.logger.log(`Registered ${prompts.length} upstream prompts`);
  }

  private registerPrompt(prompt: AggregatedPrompt): void {
    this.promptBuilder.register({
      name: prompt.name,
      ...(prompt.title !== undefined ? { title: prompt.title } : {}),
      description: prompt.description ?? `Proxied prompt from ${prompt.upstreamName}`,
      // Always pass an argument list (possibly empty) so the prompt gets an
      // argument schema and the caller's arguments reach the handler.
      arguments: prompt.arguments ?? [],
      ...(prompt.icons ? { icons: prompt.icons } : {}),
      ...(prompt._meta ? { _meta: prompt._meta } : {}),
      handler: async (args: Record<string, unknown>, ctx: McpExecutionContext) => {
        const stringArgs = Object.fromEntries(
          Object.entries(args ?? {})
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]),
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

  private async registerUpstreamResourceTemplates(): Promise<void> {
    const templates = await this.gatewayService.listResourceTemplates();
    for (const template of templates) this.registerResourceTemplate(template);
    McpGatewayModule.logger.log(`Registered ${templates.length} upstream resource templates`);
  }

  private registerResourceTemplate(template: AggregatedResourceTemplate): void {
    const handlerWrapper = {
      [template.name]: async (
        uri: URL,
        _params: Record<string, string>,
        ctx: McpExecutionContext,
      ) => this.gatewayService.readResourceTemplate(uri.href, ctx.signal),
    };

    const registered: RegisteredResourceTemplate = {
      uriTemplate: template.uriTemplate,
      name: template.name,
      ...(template.title !== undefined ? { title: template.title } : {}),
      description:
        template.description ?? `Proxied resource template from ${template.upstreamName}`,
      mimeType: template.mimeType,
      ...(template.icons ? { icons: template.icons } : {}),
      ...(template._meta ? { _meta: template._meta } : {}),
      methodName: template.name,
      target: handlerWrapper.constructor as abstract new (...args: unknown[]) => unknown,
      instance: handlerWrapper,
    };

    this.registry.registerResourceTemplate(registered);
  }

  private registerCompletionHandlers(): void {
    const prompts = this.gatewayService.getCachedPrompts();
    const templates = this.gatewayService.getCachedResourceTemplates();

    for (const prompt of prompts) this.registerPromptCompletion(prompt);
    for (const template of templates) this.registerTemplateCompletion(template);

    McpGatewayModule.logger.log(
      `Registered ${prompts.length + templates.length} completion handlers`,
    );
  }

  private registerPromptCompletion(prompt: AggregatedPrompt): void {
    const handlerObj = {
      complete: async (argName: string, argValue: string, context?: GatewayCompleteContext) =>
        this.gatewayService.complete(
          { type: 'ref/prompt', name: prompt.name },
          { name: argName, value: argValue },
          context,
        ),
    };

    this.registry.registerCompletionHandler({
      refType: 'ref/prompt',
      refName: prompt.name,
      methodName: 'complete',
      instance: handlerObj,
    });
  }

  private registerTemplateCompletion(template: AggregatedResourceTemplate): void {
    const handlerObj = {
      complete: async (argName: string, argValue: string, context?: GatewayCompleteContext) =>
        this.gatewayService.complete(
          { type: 'ref/resource', uri: template.uriTemplate },
          { name: argName, value: argValue },
          context,
        ),
    };

    this.registry.registerCompletionHandler({
      refType: 'ref/resource',
      refName: template.uriTemplate,
      methodName: 'complete',
      instance: handlerObj,
    });
  }

  // ---- Upstream list synchronisation ----

  private enqueueSync(event: UpstreamChangeEvent): Promise<void> {
    const previous = this.syncQueues.get(event.upstreamName) ?? Promise.resolve();
    const next = previous
      .then(() => this.syncUpstream(event.upstreamName, event.kinds))
      .catch((error: unknown) =>
        McpGatewayModule.logger.error(
          `Failed to re-sync upstream "${event.upstreamName}": ${extractErrorMessage(error)}`,
        ),
      );
    this.syncQueues.set(event.upstreamName, next);
    return next;
  }

  /**
   * Re-aggregate the given lists of one upstream and reconcile the registry:
   * removed items are unregistered, new or changed items are (re-)registered
   * through the dynamic builders, and each changed list is announced to the
   * downstream sessions with `notifications/<list>/list_changed`.
   */
  async syncUpstream(upstreamName: string, kinds: UpstreamListKind[]): Promise<void> {
    const changed = new Set<UpstreamListKind>();

    if (kinds.includes('tools') && (await this.syncTools(upstreamName))) {
      changed.add('tools');
    }
    if (kinds.includes('resources')) {
      const resourcesChanged = await this.syncResources(upstreamName);
      const templatesChanged = await this.syncResourceTemplates(upstreamName);
      if (resourcesChanged || templatesChanged) changed.add('resources');
    }
    if (kinds.includes('prompts') && (await this.syncPrompts(upstreamName))) {
      changed.add('prompts');
    }

    for (const kind of changed) {
      this.registry.broadcastNotification(`notifications/${kind}/list_changed`, {});
    }
    if (changed.size > 0) {
      McpGatewayModule.logger.log(
        `Re-synced ${Array.from(changed).join(', ')} from upstream "${upstreamName}"`,
      );
    }
  }

  private async syncTools(upstreamName: string): Promise<boolean> {
    const before = this.toolAggregator
      .getCachedTools()
      .filter((t) => t.upstreamName === upstreamName);
    const after = await this.toolAggregator.refreshUpstream(upstreamName);
    if (!after) return false;
    return this.reconcile(
      before,
      after,
      (t) => t.name,
      (t) => this.registerTool(t),
      (name) => this.toolBuilder.unregister(name),
    );
  }

  private async syncResources(upstreamName: string): Promise<boolean> {
    const before = this.resourceAggregator
      .getCachedResources()
      .filter((r) => r.upstreamName === upstreamName);
    const after = await this.resourceAggregator.refreshUpstream(upstreamName);
    if (!after) return false;
    return this.reconcile(
      before,
      after,
      (r) => r.uri,
      (r) => this.registerResource(r),
      (uri) => this.resourceBuilder.unregister(uri),
    );
  }

  private async syncResourceTemplates(upstreamName: string): Promise<boolean> {
    const before = this.resourceTemplateAggregator
      .getCachedTemplates()
      .filter((t) => t.upstreamName === upstreamName);
    const after = await this.resourceTemplateAggregator.refreshUpstream(upstreamName);
    if (!after) return false;
    return this.reconcile(
      before,
      after,
      (t) => t.uriTemplate,
      (t) => {
        this.registerTemplateCompletion(t);
        this.registerResourceTemplate(t);
      },
      (uriTemplate) => this.registry.unregisterResourceTemplate(uriTemplate),
    );
  }

  private async syncPrompts(upstreamName: string): Promise<boolean> {
    const before = this.promptAggregator
      .getCachedPrompts()
      .filter((p) => p.upstreamName === upstreamName);
    const after = await this.promptAggregator.refreshUpstream(upstreamName);
    if (!after) return false;
    return this.reconcile(
      before,
      after,
      (p) => p.name,
      (p) => {
        this.registerPromptCompletion(p);
        this.registerPrompt(p);
      },
      (name) => this.promptBuilder.unregister(name),
    );
  }

  /**
   * Apply the difference between two snapshots of one upstream's list.
   * Returns whether anything changed.
   */
  private reconcile<T>(
    before: T[],
    after: T[],
    keyOf: (item: T) => string,
    register: (item: T) => void,
    unregister: (key: string) => unknown,
  ): boolean {
    const previous = new Map(before.map((item) => [keyOf(item), item]));
    const current = new Map(after.map((item) => [keyOf(item), item]));
    let changed = false;

    for (const key of previous.keys()) {
      if (current.has(key)) continue;
      unregister(key);
      changed = true;
    }

    for (const [key, item] of current) {
      const old = previous.get(key);
      if (old !== undefined && JSON.stringify(old) === JSON.stringify(item)) continue;
      changed = true;
      try {
        register(item);
      } catch (error) {
        // The registry entry is already updated when this throws: a transport
        // refused to re-add a name that a live downstream session still holds
        // from when it connected. That session keeps serving the name, and
        // calls resolve through the registry by name.
        McpGatewayModule.logger.debug(
          `A downstream session kept its existing registration for "${key}": ${extractErrorMessage(error)}`,
        );
      }
    }

    return changed;
  }
}
