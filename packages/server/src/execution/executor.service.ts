import {
  type McpExecutionContext,
  type PromptGetResult,
  type ResourceReadResult,
  type ToolCallResult,
  ToolExecutionError,
  ValidationError,
  extractZodDescriptions,
  matchUriTemplate,
  zodToJsonSchema,
} from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
import type { ZodType } from 'zod';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';

@Injectable()
export class McpExecutorService {
  private readonly logger = new Logger(McpExecutorService.name);

  constructor(private readonly registry: McpRegistryService) {}

  // ---- Tools ----

  async listTools(): Promise<Array<Record<string, unknown>>> {
    return this.registry.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters ? zodToJsonSchema(tool.parameters) : { type: 'object' },
      ...(tool.outputSchema ? { outputSchema: zodToJsonSchema(tool.outputSchema) } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));
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
      const result = await handler(validatedArgs, ctx);
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

  async listResources(): Promise<Array<Record<string, unknown>>> {
    const resources = this.registry.getAllResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    }));

    return resources;
  }

  async listResourceTemplates(): Promise<Array<Record<string, unknown>>> {
    return this.registry.getAllResourceTemplates().map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.mimeType ? { mimeType: t.mimeType } : {}),
    }));
  }

  async readResource(uri: string, ctx: McpExecutionContext): Promise<ResourceReadResult> {
    // Try exact match first
    const resource = this.registry.getResource(uri);
    if (resource) {
      const handler = resource.instance[resource.methodName] as
        // biome-ignore lint/complexity/noBannedTypes: dynamic method call
        Function;
      const result = await handler(new URL(uri), ctx);
      return this.normalizeResourceResult(result, uri);
    }

    // Try template match
    for (const template of this.registry.getAllResourceTemplates()) {
      const match = matchUriTemplate(template.uriTemplate, uri);
      if (match) {
        const handler = template.instance[template.methodName] as
          // biome-ignore lint/complexity/noBannedTypes: dynamic method call
          Function;
        const result = await handler(new URL(uri), match.params, ctx);
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

  async listPrompts(): Promise<Array<Record<string, unknown>>> {
    return this.registry.getAllPrompts().map((p) => ({
      name: p.name,
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
    }));
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
    const result = await handler(validatedArgs, ctx);

    if (result && typeof result === 'object' && 'messages' in result) {
      return result as PromptGetResult;
    }

    throw new ToolExecutionError('prompts/get', 'Prompt handler must return { messages: [...] }');
  }
}
