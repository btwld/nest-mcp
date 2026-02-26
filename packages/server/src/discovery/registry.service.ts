import type {
  CircuitBreakerConfig,
  McpMiddleware,
  PromptMetadata,
  RateLimitConfig,
  ResourceMetadata,
  ResourceTemplateMetadata,
  RetryConfig,
  ToolMetadata,
} from '@btwld/mcp-common';
import {
  MCP_CIRCUIT_BREAKER_METADATA,
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
} from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';

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

@Injectable()
export class McpRegistryService {
  private readonly logger = new Logger(McpRegistryService.name);

  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, RegisteredResource>();
  private readonly resourceTemplates = new Map<string, RegisteredResourceTemplate>();
  private readonly prompts = new Map<string, RegisteredPrompt>();

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
    this.prompts.set(registered.name, registered);
    this.logger.log(`Registered prompt: ${registered.name}`);
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

  // ---- Dynamic registration ----

  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
    this.logger.log(`Dynamically registered tool: ${tool.name}`);
  }

  unregisterTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) this.logger.log(`Unregistered tool: ${name}`);
    return deleted;
  }

  registerResource(resource: RegisteredResource): void {
    this.resources.set(resource.uri, resource);
    this.logger.log(`Dynamically registered resource: ${resource.uri}`);
  }

  unregisterResource(uri: string): boolean {
    return this.resources.delete(uri);
  }

  registerPrompt(prompt: RegisteredPrompt): void {
    this.prompts.set(prompt.name, prompt);
    this.logger.log(`Dynamically registered prompt: ${prompt.name}`);
  }

  unregisterPrompt(name: string): boolean {
    return this.prompts.delete(name);
  }
}
