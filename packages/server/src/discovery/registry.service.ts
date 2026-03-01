import { EventEmitter } from 'node:events';
import type {
  CircuitBreakerConfig,
  McpMiddleware,
  PromptMetadata,
  RateLimitConfig,
  ResourceMetadata,
  ResourceTemplateMetadata,
  RetryConfig,
  ToolMetadata,
} from '@nest-mcp/common';
import {
  MCP_CIRCUIT_BREAKER_METADATA,
  MCP_COMPLETION_METADATA,
  MCP_GUARDS_METADATA,
  MCP_MIDDLEWARE_METADATA,
  MCP_PROMPT_METADATA,
  MCP_PUBLIC_METADATA,
  MCP_RATE_LIMIT_METADATA,
  MCP_RESOURCE_METADATA,
  MCP_RESOURCE_TEMPLATE_METADATA,
  MCP_RETRY_METADATA,
  MCP_ROLES_METADATA,
  MCP_SCOPES_METADATA,
  MCP_TIMEOUT_METADATA,
  MCP_TOOL_METADATA,
} from '@nest-mcp/common';
import type { CompletionMetadata } from '../decorators/completion.decorator';
import { Injectable, Logger } from '@nestjs/common';
import type { GetTaskPayloadResult, Task } from '@modelcontextprotocol/sdk/types.js';

/**
 * Configuration for proxying MCP task protocol requests to upstream servers.
 * Used by the gateway to forward tasks/list, tasks/get, tasks/cancel, and
 * tasks/result to the appropriate upstream client.
 */
export interface TaskHandlerConfig {
  listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
  getTask(taskId: string): Promise<Task | undefined>;
  cancelTask(taskId: string): Promise<Task | undefined>;
  getTaskPayload(taskId: string): Promise<GetTaskPayloadResult>;
}

export interface RegisteredTool extends ToolMetadata {
  instance: Record<string, unknown>;
}

export interface RegisteredResource extends ResourceMetadata {
  instance: Record<string, unknown>;
}

export interface RegisteredResourceTemplate extends ResourceTemplateMetadata {
  instance: Record<string, unknown>;
}

export interface RegisteredPrompt extends PromptMetadata {
  instance: Record<string, unknown>;
}

export interface RegisteredCompletion {
  refType: 'ref/prompt' | 'ref/resource';
  refName: string;
  methodName: string;
  instance: Record<string, unknown>;
}

@Injectable()
export class McpRegistryService {
  private readonly logger = new Logger(McpRegistryService.name);
  readonly events = new EventEmitter();

  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, RegisteredResource>();
  private readonly resourceTemplates = new Map<string, RegisteredResourceTemplate>();
  private readonly prompts = new Map<string, RegisteredPrompt>();
  private readonly completionHandlers = new Map<string, RegisteredCompletion>();
  private _taskHandlerConfig?: TaskHandlerConfig;

  get hasTools(): boolean {
    return this.tools.size > 0;
  }

  get hasResources(): boolean {
    return this.resources.size > 0;
  }

  get hasResourceTemplates(): boolean {
    return this.resourceTemplates.size > 0;
  }

  get hasPrompts(): boolean {
    return this.prompts.size > 0;
  }

  get taskHandlerConfig(): TaskHandlerConfig | undefined {
    return this._taskHandlerConfig;
  }

  /**
   * Register a task handler config for gateway-style task passthrough.
   * When set, the transport layer registers tasks/list, tasks/get, tasks/cancel,
   * and tasks/result handlers that delegate to this config instead of a local TaskManager.
   */
  registerTaskHandlers(config: TaskHandlerConfig): void {
    this._taskHandlerConfig = config;
  }

  /**
   * Broadcast a server-initiated notification to all active downstream sessions.
   * Used by the gateway to forward upstream notifications (e.g. notifications/tasks/status)
   * to every connected downstream client.
   */
  broadcastNotification(method: string, params: Record<string, unknown>): void {
    this.events.emit('notification.outbound', { method, params });
  }

  /**
   * Scan a provider instance for decorated methods and register them.
   */
  registerProvider(instance: unknown): void {
    if (!instance || !(instance as Record<string, unknown>).constructor) return;

    const prototype = Object.getPrototypeOf(instance);
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name] === 'function',
    );

    for (const methodName of methodNames) {
      this.scanToolMetadata(instance as Record<string, unknown>, prototype, methodName);
      this.scanResourceMetadata(instance as Record<string, unknown>, prototype, methodName);
      this.scanResourceTemplateMetadata(instance as Record<string, unknown>, prototype, methodName);
      this.scanPromptMetadata(instance as Record<string, unknown>, prototype, methodName);
      this.scanCompletionMetadata(instance as Record<string, unknown>, prototype, methodName);
    }
  }

  private scanToolMetadata(
    instance: Record<string, unknown>,
    prototype: object,
    methodName: string,
  ): void {
    const metadata: ToolMetadata | undefined = Reflect.getMetadata(
      MCP_TOOL_METADATA,
      prototype,
      methodName,
    );
    if (!metadata) return;

    // Merge auth/resilience decorators
    const enriched: RegisteredTool = {
      ...metadata,
      instance,
      isPublic: Reflect.getMetadata(MCP_PUBLIC_METADATA, prototype, methodName) ?? false,
      requiredScopes: Reflect.getMetadata(MCP_SCOPES_METADATA, prototype, methodName),
      requiredRoles: Reflect.getMetadata(MCP_ROLES_METADATA, prototype, methodName),
      guards: Reflect.getMetadata(MCP_GUARDS_METADATA, prototype, methodName),
      middleware: Reflect.getMetadata(MCP_MIDDLEWARE_METADATA, prototype, methodName),
      rateLimit: Reflect.getMetadata(MCP_RATE_LIMIT_METADATA, prototype, methodName),
      retry: Reflect.getMetadata(MCP_RETRY_METADATA, prototype, methodName),
      circuitBreaker: Reflect.getMetadata(MCP_CIRCUIT_BREAKER_METADATA, prototype, methodName),
      timeout: Reflect.getMetadata(MCP_TIMEOUT_METADATA, prototype, methodName),
    };

    if (this.tools.has(enriched.name)) {
      this.logger.warn(`Duplicate tool name: ${enriched.name}. Overwriting.`);
    }

    this.warnIfMissingDescription('Tool', enriched.name, enriched.description);
    this.tools.set(enriched.name, enriched);
    this.logger.log(`Registered tool: ${enriched.name}`);
  }

  private scanResourceMetadata(
    instance: Record<string, unknown>,
    prototype: object,
    methodName: string,
  ): void {
    const metadata: ResourceMetadata | undefined = Reflect.getMetadata(
      MCP_RESOURCE_METADATA,
      prototype,
      methodName,
    );
    if (!metadata) return;

    const registered: RegisteredResource = { ...metadata, instance };
    this.warnIfMissingDescription('Resource', registered.name, registered.description);
    this.resources.set(registered.uri, registered);
    this.logger.log(`Registered resource: ${registered.uri}`);
  }

  private scanResourceTemplateMetadata(
    instance: Record<string, unknown>,
    prototype: object,
    methodName: string,
  ): void {
    const metadata: ResourceTemplateMetadata | undefined = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      prototype,
      methodName,
    );
    if (!metadata) return;

    const registered: RegisteredResourceTemplate = { ...metadata, instance };
    this.warnIfMissingDescription('ResourceTemplate', registered.name, registered.description);
    this.resourceTemplates.set(registered.uriTemplate, registered);
    this.logger.log(`Registered resource template: ${registered.uriTemplate}`);
  }

  private scanPromptMetadata(
    instance: Record<string, unknown>,
    prototype: object,
    methodName: string,
  ): void {
    const metadata: PromptMetadata | undefined = Reflect.getMetadata(
      MCP_PROMPT_METADATA,
      prototype,
      methodName,
    );
    if (!metadata) return;

    const registered: RegisteredPrompt = { ...metadata, instance };
    this.warnIfMissingDescription('Prompt', registered.name, registered.description);
    this.prompts.set(registered.name, registered);
    this.logger.log(`Registered prompt: ${registered.name}`);
  }

  private scanCompletionMetadata(
    instance: Record<string, unknown>,
    prototype: object,
    methodName: string,
  ): void {
    const metadata: CompletionMetadata | undefined = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      prototype,
      methodName,
    );
    if (!metadata) return;

    const key = `${metadata.refType === 'ref/prompt' ? 'prompt' : 'resource'}::${metadata.refName}`;
    const registered: RegisteredCompletion = {
      refType: metadata.refType,
      refName: metadata.refName,
      methodName: metadata.methodName,
      instance,
    };

    this.completionHandlers.set(key, registered);
    this.logger.log(`Registered completion handler: ${key}`);
  }

  // ---- Accessors ----

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  getResource(uri: string): RegisteredResource | undefined {
    return this.resources.get(uri);
  }

  getAllResources(): RegisteredResource[] {
    return Array.from(this.resources.values());
  }

  getResourceTemplate(uriTemplate: string): RegisteredResourceTemplate | undefined {
    return this.resourceTemplates.get(uriTemplate);
  }

  getAllResourceTemplates(): RegisteredResourceTemplate[] {
    return Array.from(this.resourceTemplates.values());
  }

  getPrompt(name: string): RegisteredPrompt | undefined {
    return this.prompts.get(name);
  }

  getAllPrompts(): RegisteredPrompt[] {
    return Array.from(this.prompts.values());
  }

  getCompletionHandler(refType: 'ref/prompt' | 'ref/resource', refName: string): RegisteredCompletion | undefined {
    const key = `${refType === 'ref/prompt' ? 'prompt' : 'resource'}::${refName}`;
    return this.completionHandlers.get(key);
  }

  getAllCompletionHandlers(): RegisteredCompletion[] {
    return Array.from(this.completionHandlers.values());
  }

  // ---- Dynamic registration ----

  registerTool(tool: RegisteredTool): void {
    this.warnIfMissingDescription('Tool', tool.name, tool.description);
    this.tools.set(tool.name, tool);
    this.logger.log(`Dynamically registered tool: ${tool.name}`);
    this.events.emit('tool.registered', tool);
  }

  unregisterTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      this.logger.log(`Unregistered tool: ${name}`);
      this.events.emit('tool.unregistered', name);
    }
    return deleted;
  }

  registerResource(resource: RegisteredResource): void {
    this.warnIfMissingDescription('Resource', resource.name, resource.description);
    this.resources.set(resource.uri, resource);
    this.logger.log(`Dynamically registered resource: ${resource.uri}`);
    this.events.emit('resource.registered', resource);
  }

  unregisterResource(uri: string): boolean {
    const deleted = this.resources.delete(uri);
    if (deleted) {
      this.events.emit('resource.unregistered', uri);
    }
    return deleted;
  }

  registerPrompt(prompt: RegisteredPrompt): void {
    this.warnIfMissingDescription('Prompt', prompt.name, prompt.description);
    this.prompts.set(prompt.name, prompt);
    this.logger.log(`Dynamically registered prompt: ${prompt.name}`);
    this.events.emit('prompt.registered', prompt);
  }

  registerResourceTemplate(template: RegisteredResourceTemplate): void {
    this.warnIfMissingDescription('ResourceTemplate', template.name, template.description);
    this.resourceTemplates.set(template.uriTemplate, template);
    this.logger.log(`Dynamically registered resource template: ${template.uriTemplate}`);
    this.events.emit('resourceTemplate.registered', template);
  }

  unregisterResourceTemplate(uriTemplate: string): boolean {
    const deleted = this.resourceTemplates.delete(uriTemplate);
    if (deleted) {
      this.events.emit('resourceTemplate.unregistered', uriTemplate);
    }
    return deleted;
  }

  registerCompletionHandler(handler: RegisteredCompletion): void {
    const key = `${handler.refType === 'ref/prompt' ? 'prompt' : 'resource'}::${handler.refName}`;
    this.completionHandlers.set(key, handler);
    this.logger.log(`Dynamically registered completion handler: ${key}`);
  }

  private warnIfMissingDescription(type: string, name: string, description?: string): void {
    if (!description) {
      this.logger.warn(
        `${type} "${name}" registered without a description. Descriptions are strongly recommended by the MCP specification.`,
      );
    }
  }

  unregisterPrompt(name: string): boolean {
    const deleted = this.prompts.delete(name);
    if (deleted) {
      this.events.emit('prompt.unregistered', name);
    }
    return deleted;
  }
}
