import {
  type CompletionRequest,
  type CompletionResult,
  MCP_OPTIONS,
  type McpExecutionContext,
  type McpModuleOptions,
  type PaginatedResult,
  type PromptGetResult,
  type ResourceReadResult,
  type ToolCallResult,
  ToolExecutionError,
  ValidationError,
  extractZodDescriptions,
  matchUriTemplate,
  paginate,
  zodToJsonSchema,
} from '@nest-mcp/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ZodEnum, ZodObject, type ZodType } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';

@Injectable()
export class McpExecutorService {
  private readonly logger = new Logger(McpExecutorService.name);
  private readonly pageSize: number | undefined;

  constructor(
    private readonly registry: McpRegistryService,
    @Inject(MCP_OPTIONS) options: McpModuleOptions,
  ) {
    this.pageSize = options.pagination?.defaultPageSize;
  }

  // ---- Tools ----

  async listTools(cursor?: string): Promise<PaginatedResult<Record<string, unknown>>> {
    const all = this.registry.getAllTools().map((tool) => ({
      name: tool.name,
      ...(tool.title != null ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.parameters
        ? zodToJsonSchema(tool.parameters)
        : (tool.inputSchema ?? { type: 'object' }),
      ...(tool.outputSchema
        ? { outputSchema: zodToJsonSchema(tool.outputSchema) }
        : tool.rawOutputSchema
          ? { outputSchema: tool.rawOutputSchema }
          : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool.icons ? { icons: tool.icons } : {}),
      ...(tool.execution ? { execution: tool.execution } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
    }));
    return paginate(all, cursor, this.pageSize);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<ToolCallResult> {
    const tool = this.registry.getTool(name);
    if (!tool) {
      throw new ToolExecutionError(name, `Tool '${name}' not found`);
    }

    const validatedArgs = tool.parameters
      ? this.validateInput(tool.parameters, args, `tool '${name}'`)
      : args;

    try {
      const handler = tool.instance[tool.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await handler.call(tool.instance, validatedArgs, ctx);
      return this.normalizeToolResult(result);
    } catch (error) {
      if (error instanceof ToolExecutionError || error instanceof ValidationError) {
        throw error;
      }
      throw new ToolExecutionError(
        name,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined,
      );
    }
  }

  private validateInput(
    schema: ZodType,
    args: Record<string, unknown>,
    label: string,
  ): Record<string, unknown> {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid parameters for ${label}`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  private normalizeToolResult(result: unknown): ToolCallResult {
    if (result === null || result === undefined) {
      return { content: [{ type: 'text', text: '' }] };
    }

    // Already in ToolCallResult format
    if (typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
      return result as ToolCallResult;
    }

    // String result
    if (typeof result === 'string') {
      return { content: [{ type: 'text', text: result }] };
    }

    // Object result - serialize to JSON
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  // ---- Resources ----

  async listResources(cursor?: string): Promise<PaginatedResult<Record<string, unknown>>> {
    const all = this.registry.getAllResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.title != null ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      ...(r.icons ? { icons: r.icons } : {}),
      ...(r._meta ? { _meta: r._meta } : {}),
    }));
    return paginate(all, cursor, this.pageSize);
  }

  async listResourceTemplates(cursor?: string): Promise<PaginatedResult<Record<string, unknown>>> {
    const all = this.registry.getAllResourceTemplates().map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      ...(t.title != null ? { title: t.title } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.mimeType ? { mimeType: t.mimeType } : {}),
      ...(t.icons ? { icons: t.icons } : {}),
      ...(t._meta ? { _meta: t._meta } : {}),
    }));
    return paginate(all, cursor, this.pageSize);
  }

  async readResource(uri: string, ctx: McpExecutionContext): Promise<ResourceReadResult> {
    // Try exact match first
    const resource = this.registry.getResource(uri);
    if (resource) {
      const handler = resource.instance[resource.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await handler.call(resource.instance, new URL(uri), ctx);
      return this.normalizeResourceResult(result, uri);
    }

    // Try template match
    for (const template of this.registry.getAllResourceTemplates()) {
      const match = matchUriTemplate(template.uriTemplate, uri);
      if (match) {
        const handler = template.instance[template.methodName] as
          // biome-ignore lint/complexity/noBannedTypes: dynamic method call
          Function;
        const result = await handler.call(template.instance, new URL(uri), match.params, ctx);
        return this.normalizeResourceResult(result, uri);
      }
    }

    throw new ToolExecutionError('resources/read', `Resource not found: ${uri}`);
  }

  private normalizeResourceResult(result: unknown, uri: string): ResourceReadResult {
    if (result && typeof result === 'object' && 'contents' in (result as Record<string, unknown>)) {
      return result as ResourceReadResult;
    }

    if (typeof result === 'string') {
      return { contents: [{ uri, text: result }] };
    }

    return {
      contents: [{ uri, text: JSON.stringify(result) }],
    };
  }

  // ---- Prompts ----

  async listPrompts(cursor?: string): Promise<PaginatedResult<Record<string, unknown>>> {
    const all = this.registry.getAllPrompts().map((p) => ({
      name: p.name,
      ...(p.title != null ? { title: p.title } : {}),
      description: p.description,
      ...(p.parameters
        ? {
            arguments: extractZodDescriptions(p.parameters).map((arg) => ({
              name: arg.name,
              description: arg.description,
              required: arg.required,
            })),
          }
        : {}),
      ...(p.icons ? { icons: p.icons } : {}),
      ...(p._meta ? { _meta: p._meta } : {}),
    }));
    return paginate(all, cursor, this.pageSize);
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<PromptGetResult> {
    const prompt = this.registry.getPrompt(name);
    if (!prompt) {
      throw new ToolExecutionError('prompts/get', `Prompt '${name}' not found`);
    }

    const validatedArgs = prompt.parameters
      ? this.validateInput(prompt.parameters, args, `prompt '${name}'`)
      : args;

    const handler = prompt.instance[prompt.methodName] as
      // biome-ignore lint/complexity/noBannedTypes: dynamic method call
      Function;
    const result = await handler.call(prompt.instance, validatedArgs, ctx);

    if (result && typeof result === 'object' && 'messages' in result) {
      return result as PromptGetResult;
    }

    throw new ToolExecutionError('prompts/get', 'Prompt handler must return { messages: [...] }');
  }

  // ---- Completions ----

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const refName = request.ref.type === 'ref/prompt' ? request.ref.name : request.ref.uri;
    const handler = this.registry.getCompletionHandler(request.ref.type, refName);

    if (handler) {
      const fn = handler.instance[handler.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await fn.call(
        handler.instance,
        request.argument.name,
        request.argument.value,
        request.context,
      );
      return this.normalizeCompletionResult(result);
    }

    return this.defaultComplete(request);
  }

  private defaultComplete(request: CompletionRequest): CompletionResult {
    const empty: CompletionResult = { values: [] };

    if (request.ref.type === 'ref/prompt') {
      return this.defaultPromptComplete(request.ref.name, request.argument);
    }

    if (request.ref.type === 'ref/resource') {
      return this.defaultResourceComplete(request.ref.uri, request.argument);
    }

    return empty;
  }

  private defaultPromptComplete(
    promptName: string,
    argument: { name: string; value: string },
  ): CompletionResult {
    const prompt = this.registry.getPrompt(promptName);
    if (!prompt?.parameters) return { values: [] };

    if (!(prompt.parameters instanceof ZodObject)) return { values: [] };
    const shape = prompt.parameters.shape;

    const field = shape[argument.name] as ZodType | undefined;
    if (!field) return { values: [] };

    // Support ZodEnum fields: filter values by prefix
    if (field instanceof ZodEnum) {
      const prefix = argument.value.toLowerCase();
      const filtered = (field.options as string[]).filter((v) =>
        v.toLowerCase().startsWith(prefix),
      );
      return this.normalizeCompletionResult({ values: filtered });
    }

    return { values: [] };
  }

  private defaultResourceComplete(
    _uri: string,
    _argument: { name: string; value: string },
  ): CompletionResult {
    // Resource template completion requires domain-specific knowledge.
    // Without a custom handler, return empty results.
    return { values: [] };
  }

  private normalizeCompletionResult(result: unknown): CompletionResult {
    if (!result || typeof result !== 'object') return { values: [] };

    const r = result as { values?: unknown[]; hasMore?: boolean; total?: number };
    if (!Array.isArray(r.values)) return { values: [] };

    const MAX_COMPLETION_VALUES = 100;
    const allValues = r.values.map(String);
    const truncated = allValues.length > MAX_COMPLETION_VALUES;
    const values = truncated ? allValues.slice(0, MAX_COMPLETION_VALUES) : allValues;

    return {
      values,
      ...(truncated || r.hasMore ? { hasMore: true } : {}),
      ...(r.total != null ? { total: r.total } : truncated ? { total: allValues.length } : {}),
    };
  }
}
