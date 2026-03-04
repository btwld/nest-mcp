import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpExecutionContext, McpModuleOptions } from '@nest-mcp/common';
import { MCP_OPTIONS, McpTransportType } from '@nest-mcp/common';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type {
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../../discovery/registry.service';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpContextFactory } from '../../execution/context.factory';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
import { ResourceSubscriptionManager } from '../../subscription/resource-subscription.manager';
import { TaskManager } from '../../task/task.manager';
import {
  registerHandlers,
  registerPromptOnServer,
  registerResourceOnServer,
  registerResourceTemplateOnServer,
  registerToolOnServer,
} from '../register-handlers';
import type { SdkHandle } from '../register-handlers';

@Injectable()
export class StdioService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StdioService.name);
  private server?: McpServer;
  private ctx?: McpExecutionContext;
  private started = false;
  /** SDK handles keyed by item name/uri for removal. */
  private readonly sdkHandles = new Map<string, SdkHandle>();

  private readonly registryListeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
    @Optional() private readonly subscriptionManager?: ResourceSubscriptionManager,
    @Optional() private readonly taskManager?: TaskManager,
  ) {
    this.subscribeToRegistryEvents();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const transport = new StdioServerTransport();
    const server = createMcpServer(this.registry, this.options, this.taskManager);

    const subMgr = this.subscriptionManager;
    const ctx = this.contextFactory.createContext({
      sessionId: 'stdio',
      transport: McpTransportType.STDIO,
      mcpServer: server,
      notifyResourceUpdated: subMgr ? (uri) => subMgr.notifyResourceUpdated(uri) : undefined,
    });

    registerHandlers(
      server,
      this.registry,
      this.pipeline,
      ctx,
      this.options,
      this.subscriptionManager,
    );

    this.server = server;
    this.ctx = ctx;

    await server.connect(transport);
    this.logger.log('STDIO transport connected');
  }

  private subscribeToRegistryEvents(): void {
    const onToolRegistered = (tool: RegisteredTool) => {
      if (!this.server || !this.ctx) return;
      const handle = registerToolOnServer(this.server, tool, this.pipeline, this.ctx);
      this.sdkHandles.set(`tool:${tool.name}`, handle);
    };

    const onToolUnregistered = (name: string) => {
      const handle = this.sdkHandles.get(`tool:${name}`);
      if (handle) {
        handle.remove();
        this.sdkHandles.delete(`tool:${name}`);
      }
    };

    const onResourceRegistered = (resource: RegisteredResource) => {
      if (!this.server || !this.ctx) return;
      const handle = registerResourceOnServer(this.server, resource, this.pipeline, this.ctx);
      this.sdkHandles.set(`resource:${resource.uri}`, handle);
    };

    const onResourceUnregistered = (uri: string) => {
      const handle = this.sdkHandles.get(`resource:${uri}`);
      if (handle) {
        handle.remove();
        this.sdkHandles.delete(`resource:${uri}`);
      }
    };

    const onPromptRegistered = (prompt: RegisteredPrompt) => {
      if (!this.server || !this.ctx) return;
      const handle = registerPromptOnServer(this.server, prompt, this.pipeline, this.ctx);
      this.sdkHandles.set(`prompt:${prompt.name}`, handle);
    };

    const onPromptUnregistered = (name: string) => {
      const handle = this.sdkHandles.get(`prompt:${name}`);
      if (handle) {
        handle.remove();
        this.sdkHandles.delete(`prompt:${name}`);
      }
    };

    const onResourceTemplateRegistered = (template: RegisteredResourceTemplate) => {
      if (!this.server || !this.ctx) return;
      const handle = registerResourceTemplateOnServer(
        this.server,
        template,
        this.pipeline,
        this.ctx,
      );
      this.sdkHandles.set(`resourceTemplate:${template.uriTemplate}`, handle);
    };

    const onResourceTemplateUnregistered = (uriTemplate: string) => {
      const handle = this.sdkHandles.get(`resourceTemplate:${uriTemplate}`);
      if (handle) {
        handle.remove();
        this.sdkHandles.delete(`resourceTemplate:${uriTemplate}`);
      }
    };

    this.registry.events.on('tool.registered', onToolRegistered);
    this.registry.events.on('tool.unregistered', onToolUnregistered);
    this.registry.events.on('resource.registered', onResourceRegistered);
    this.registry.events.on('resource.unregistered', onResourceUnregistered);
    this.registry.events.on('prompt.registered', onPromptRegistered);
    this.registry.events.on('prompt.unregistered', onPromptUnregistered);
    this.registry.events.on('resourceTemplate.registered', onResourceTemplateRegistered);
    this.registry.events.on('resourceTemplate.unregistered', onResourceTemplateUnregistered);

    this.registryListeners.push(
      { event: 'tool.registered', listener: onToolRegistered as (...args: unknown[]) => void },
      { event: 'tool.unregistered', listener: onToolUnregistered as (...args: unknown[]) => void },
      {
        event: 'resource.registered',
        listener: onResourceRegistered as (...args: unknown[]) => void,
      },
      {
        event: 'resource.unregistered',
        listener: onResourceUnregistered as (...args: unknown[]) => void,
      },
      { event: 'prompt.registered', listener: onPromptRegistered as (...args: unknown[]) => void },
      {
        event: 'prompt.unregistered',
        listener: onPromptUnregistered as (...args: unknown[]) => void,
      },
      {
        event: 'resourceTemplate.registered',
        listener: onResourceTemplateRegistered as (...args: unknown[]) => void,
      },
      {
        event: 'resourceTemplate.unregistered',
        listener: onResourceTemplateUnregistered as (...args: unknown[]) => void,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriptionManager?.removeSession('stdio');
    this.taskManager?.removeSession('stdio');

    for (const { event, listener } of this.registryListeners) {
      this.registry.events.removeListener(event, listener);
    }
    this.registryListeners.length = 0;

    if (this.server) {
      await this.server.close();
    }
  }
}
