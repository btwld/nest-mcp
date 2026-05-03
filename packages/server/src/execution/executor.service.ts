import {
  type CompletionRequest,
  type CompletionResult,
  JSON_RPC_INTERNAL_ERROR,
  MCP_OPTIONS,
  McpError,
  type McpExecutionContext,
  type McpModuleOptions,
  type PaginatedResult,
  type PromptGetResult,
  type ResourceReadResult,
  type ToolCallResult,
  ToolExecutionError,
  type ToolListEntry,
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
import { isPlainRecord } from '../utils/coerce';
import { type FilterTarget, McpExceptionFilterRunner } from './exception-filter.runner';

interface ZodIssueLike {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

function formatZodIssues(issues: ReadonlyArray<ZodIssueLike>): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '';
      return path ? `[${path}]: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Structural type guard: "is this object already in the SDK's
 * `ToolCallResult` envelope shape?". Trusts the discriminator (`content`
 * key present) — same trust as the previous `as ToolCallResult` cast,
 * just localized to one predicate.
 */
function isToolCallResult(value: unknown): value is ToolCallResult {
  return isPlainRecord(value) && 'content' in value;
}

/** Coerce arbitrary handler returns into the SDK `ToolCallResult` envelope. */
function shapeToolResult(result: unknown): ToolCallResult {
  if (result === null || result === undefined) {
    return { content: [{ type: 'text', text: '' }] };
  }
  if (isToolCallResult(result)) return result;
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/** Pick the structured payload from a raw handler return, or `undefined` when there isn't one. */
function extractStructuredCandidate(result: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(result) || isToolCallResult(result)) return undefined;
  return result;
}

@Injectable()
export class McpExecutorService {
  private readonly logger = new Logger(McpExecutorService.name);
  private readonly pageSize: number | undefined;

  constructor(
    private readonly registry: McpRegistryService,
    private readonly exceptionFilters: McpExceptionFilterRunner,
    @Inject(MCP_OPTIONS) options: McpModuleOptions,
  ) {
    this.pageSize = options.pagination?.defaultPageSize;
  }

  // ---- Tools ----

  /**
   * Build the full list of tool entries (unpaginated) in the same shape
   * surfaced by `tools/list`. Exposed so that the pipeline can insert a
   * catalog-presentation transform (see {@link ExposureService}) before
   * pagination — filtering or annotating entries post-pagination would
   * produce uneven page sizes.
   */
  buildToolEntries(): ToolListEntry[] {
    return this.registry.getAllTools().map((tool): ToolListEntry => {
      const inputSchema = tool.parameters
        ? (zodToJsonSchema(tool.parameters) as Record<string, unknown>)
        : (tool.inputSchema ?? { type: 'object' });
      const outputSchema = tool.outputSchema
        ? (zodToJsonSchema(tool.outputSchema) as Record<string, unknown>)
        : tool.rawOutputSchema;
      return {
        name: tool.name,
        ...(tool.title != null ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.icons ? { icons: tool.icons } : {}),
        ...(tool.execution ? { execution: tool.execution } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {}),
      };
    });
  }

  async listTools(cursor?: string): Promise<PaginatedResult<ToolListEntry>> {
    return paginate(this.buildToolEntries(), cursor, this.pageSize);
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

    let validatedArgs: Record<string, unknown> = args;
    if (tool.parameters) {
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) {
        // MCP spec: tool input-validation failures must surface as a tool
        // result with `isError: true` so the model can self-correct. Throwing
        // would surface as a JSON-RPC `InvalidParams` and abort the call.
        return {
          isError: true,
          content: [
            { type: 'text', text: `Invalid parameters: ${formatZodIssues(parsed.error.issues)}` },
          ],
        };
      }
      validatedArgs = parsed.data as Record<string, unknown>;
    }

    try {
      const handler = tool.instance[tool.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await handler.call(tool.instance, validatedArgs, ctx);
      return this.normalizeToolResult(result, tool);
    } catch (error) {
      if (error instanceof ToolExecutionError || error instanceof ValidationError) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      const filtered = this.applyExceptionFilters(err, tool, ctx);
      if (filtered) throw filtered;
      throw new ToolExecutionError(name, err.message, err);
    }
  }

  /**
   * Walk `@UseFilters` metadata on the capability's class/method. If a filter
   * handles the error, render its result as an `McpError` (matches upstream
   * behavior — filter output flows back as a JSON-RPC error). Returns `null`
   * when no filter matches.
   */
  private applyExceptionFilters(
    error: Error,
    info: FilterTarget | undefined,
    ctx: McpExecutionContext,
  ): McpError | null {
    if (!info?.target || !info.methodName) return null;
    const message = this.exceptionFilters.apply(error, info, ctx.request);
    if (message == null) return null;
    return new McpError(message, JSON_RPC_INTERNAL_ERROR);
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

  private normalizeToolResult(result: unknown, tool?: RegisteredTool): ToolCallResult {
    const normalized = shapeToolResult(result);
    if (!tool?.outputSchema || normalized.isError) return normalized;
    return this.attachStructuredContent(normalized, result, tool, tool.outputSchema);
  }

  /**
   * Per MCP spec, validate the handler return against the tool's
   * `outputSchema` and stamp the parsed value onto `structuredContent`.
   * Falls back to the raw result object when the handler didn't pre-set
   * `structuredContent`. Skips quietly when there's nothing to validate.
   */
  private attachStructuredContent(
    normalized: ToolCallResult,
    rawResult: unknown,
    tool: RegisteredTool,
    outputSchema: ZodType,
  ): ToolCallResult {
    const candidate = normalized.structuredContent ?? extractStructuredCandidate(rawResult);
    if (candidate === undefined) return normalized;

    const parsed = outputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ToolExecutionError(
        tool.name,
        `outputSchema validation failed: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
    return { ...normalized, structuredContent: parsed.data as Record<string, unknown> };
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
      try {
        const handler = resource.instance[resource.methodName] as
          // biome-ignore lint/complexity/noBannedTypes: dynamic method call
          Function;
        const result = await handler.call(resource.instance, new URL(uri), ctx);
        return this.normalizeResourceResult(result, uri);
      } catch (error) {
        throw this.processCapabilityError(error, resource, ctx);
      }
    }

    // Try template match
    for (const template of this.registry.getAllResourceTemplates()) {
      const match = matchUriTemplate(template.uriTemplate, uri);
      if (match) {
        try {
          const handler = template.instance[template.methodName] as
            // biome-ignore lint/complexity/noBannedTypes: dynamic method call
            Function;
          const result = await handler.call(template.instance, new URL(uri), match.params, ctx);
          return this.normalizeResourceResult(result, uri);
        } catch (error) {
          throw this.processCapabilityError(error, template, ctx);
        }
      }
    }

    throw new ToolExecutionError('resources/read', `Resource not found: ${uri}`);
  }

  /**
   * Funnel a raw user error from a resource/prompt handler through the
   * exception-filter pipeline. Existing protocol errors (`McpError` family)
   * are passed through untouched. Always returns a real `Error` subclass —
   * lets call sites narrow without an `unknown` cast.
   */
  private processCapabilityError(
    error: unknown,
    info: FilterTarget,
    ctx: McpExecutionContext,
  ): Error {
    if (error instanceof McpError) return error;
    const err = error instanceof Error ? error : new Error(String(error));
    return this.applyExceptionFilters(err, info, ctx) ?? err;
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

    let result: unknown;
    try {
      const handler = prompt.instance[prompt.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      result = await handler.call(prompt.instance, validatedArgs, ctx);
    } catch (error) {
      throw this.processCapabilityError(error, prompt, ctx);
    }

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
