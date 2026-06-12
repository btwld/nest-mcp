import {
  type CompletionRequest,
  type CompletionResult,
  JSON_RPC_INTERNAL_ERROR,
  MCP_OPTIONS,
  McpError,
  type McpExecutionContext,
  type McpModuleOptions,
  type McpSecurityScheme,
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
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { ZodEnum, ZodObject, type ZodType } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type { ProviderBinding, RegisteredTool } from '../discovery/registry.service';
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
  private readonly advertiseSecuritySchemes: boolean;
  private readonly moduleRequiresAuth: boolean;

  constructor(
    private readonly registry: McpRegistryService,
    private readonly exceptionFilters: McpExceptionFilterRunner,
    @Inject(MCP_OPTIONS) options: McpModuleOptions,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.pageSize = options.pagination?.defaultPageSize;
    this.advertiseSecuritySchemes = options.advertiseSecuritySchemes ?? false;
    this.moduleRequiresAuth =
      Boolean(options.guards?.length) ||
      Boolean(options.transportOptions?.streamableHttp?.oauth?.enabled) ||
      Boolean(options.transportOptions?.sse?.oauth?.enabled);
  }

  /**
   * Resolve the provider object to invoke a capability on. Singleton
   * providers carry a live `instance` from scan time; request/transient-scoped
   * providers carry a `scopedTarget` class resolved fresh per call. When the
   * execution context has an HTTP request, it is registered on the context id
   * so `@Inject(REQUEST)` works inside scoped providers.
   */
  private async resolveBinding(
    binding: ProviderBinding,
    label: string,
    ctx?: McpExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (binding.instance) return binding.instance;
    if (binding.scopedTarget && this.moduleRef) {
      const contextId = ContextIdFactory.create();
      if (ctx?.request) {
        this.moduleRef.registerRequestByContextId(ctx.request, contextId);
      }
      return this.moduleRef.resolve(binding.scopedTarget, contextId, { strict: false });
    }
    throw new ToolExecutionError(
      label,
      binding.scopedTarget
        ? `Cannot resolve request-scoped provider '${binding.scopedTarget.name}' without a ModuleRef`
        : `No provider bound for '${label}'`,
    );
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
      const meta = this.advertiseSecuritySchemes
        ? { ...(tool._meta ?? {}), securitySchemes: this.buildSecuritySchemes(tool) }
        : tool._meta;
      return {
        name: tool.name,
        ...(tool.title != null ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.icons ? { icons: tool.icons } : {}),
        ...(tool.execution ? { execution: tool.execution } : {}),
        ...(meta ? { _meta: meta } : {}),
      };
    });
  }

  /**
   * Derive the advertised auth requirements for a tool from its `@Public` /
   * `@Scopes` metadata. `oauth2` without scopes means "any authenticated
   * caller" and is emitted when the module itself gates requests (guards or
   * an OAuth-enabled transport) and the tool isn't public.
   */
  private buildSecuritySchemes(tool: RegisteredTool): McpSecurityScheme[] {
    const schemes: McpSecurityScheme[] = [];
    if (tool.isPublic) schemes.push({ type: 'noauth' });
    if (tool.requiredScopes?.length) {
      schemes.push({ type: 'oauth2', scopes: tool.requiredScopes });
    } else if (this.moduleRequiresAuth && !tool.isPublic) {
      schemes.push({ type: 'oauth2' });
    }
    if (schemes.length === 0) schemes.push({ type: 'noauth' });
    return schemes;
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
      const instance = await this.resolveBinding(tool, name, ctx);
      const handler = instance[tool.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await handler.call(instance, validatedArgs, ctx);
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
        const instance = await this.resolveBinding(resource, uri, ctx);
        const handler = instance[resource.methodName] as
          // biome-ignore lint/complexity/noBannedTypes: dynamic method call
          Function;
        const result = await handler.call(instance, new URL(uri), ctx);
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
          const instance = await this.resolveBinding(template, uri, ctx);
          const handler = instance[template.methodName] as
            // biome-ignore lint/complexity/noBannedTypes: dynamic method call
            Function;
          const result = await handler.call(instance, new URL(uri), match.params, ctx);
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
      const instance = await this.resolveBinding(prompt, name, ctx);
      const handler = instance[prompt.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      result = await handler.call(instance, validatedArgs, ctx);
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
      const instance = await this.resolveBinding(handler, `completion ${refName}`);
      const fn = instance[handler.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await fn.call(
        instance,
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
