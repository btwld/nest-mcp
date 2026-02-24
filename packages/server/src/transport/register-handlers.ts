import { extractZodDescriptions } from '@btwld/mcp-common';
import type { McpExecutionContext } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RegisteredPrompt, RegisteredTool } from '../discovery/registry.service';
import type { McpRegistryService } from '../discovery/registry.service';
import type { ExecutionPipelineService } from '../execution/pipeline.service';

/**
 * Permissive schema that accepts any arguments. Used for dynamically-registered
 * tools (e.g. gateway-proxied tools) that only have JSON schemas, not Zod schemas.
 * The MCP SDK requires a Zod schema to pass arguments to the handler callback.
 */
const PASSTHROUGH_SCHEMA = z.object({}).passthrough();

/**
 * Registers all tools, resources, resource templates, and prompts from the
 * registry onto an McpServer instance, including parameter schemas, prompt
 * argument metadata, and resource mimeType information.
 *
 * Shared across all transport implementations (streamable HTTP, SSE, stdio).
 */
export function registerHandlers(
  server: McpServer,
  registry: McpRegistryService,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): void {
  registerTools(server, registry, pipeline, ctx);
  registerResources(server, registry, pipeline, ctx);
  registerResourceTemplates(server, registry, pipeline, ctx);
  registerPrompts(server, registry, pipeline, ctx);
}

function registerTools(
  server: McpServer,
  registry: McpRegistryService,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): void {
  for (const tool of registry.getAllTools()) {
    // Use registerTool() with named config to avoid overload ambiguity
    // The SDK's tool() method uses isZodRawShapeCompat() to distinguish params
    // from annotations, which fails for pre-converted JSON schema objects.
    (server as unknown as { registerTool: (...args: unknown[]) => void }).registerTool(
      tool.name,
      {
        description: tool.description,
        // Use Zod schema for validation, or a permissive passthrough schema
        // for dynamically-registered tools that only have JSON schemas.
        // A schema is always required so the SDK passes args to the callback.
        inputSchema: tool.parameters ?? PASSTHROUGH_SCHEMA,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        return pipeline.callTool(tool.name, args, ctx);
      },
    );
  }
}

function registerResources(
  server: McpServer,
  registry: McpRegistryService,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): void {
  for (const resource of registry.getAllResources()) {
    (server as unknown as { resource: (...args: unknown[]) => void }).resource(
      resource.name,
      resource.uri,
      resource.mimeType ? { mimeType: resource.mimeType } : {},
      async (uri: URL) => {
        return pipeline.readResource(uri.href, ctx);
      },
    );
  }
}

function registerResourceTemplates(
  server: McpServer,
  registry: McpRegistryService,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): void {
  for (const template of registry.getAllResourceTemplates()) {
    (server as unknown as { resource: (...args: unknown[]) => void }).resource(
      template.name,
      template.uriTemplate,
      template.mimeType ? { mimeType: template.mimeType } : {},
      async (uri: URL) => {
        return pipeline.readResource(uri.href, ctx);
      },
    );
  }
}

function registerPrompts(
  server: McpServer,
  registry: McpRegistryService,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): void {
  for (const prompt of registry.getAllPrompts()) {
    const promptArgs = prompt.parameters ? getPromptArgs(prompt) : {};
    (server as unknown as { prompt: (...args: unknown[]) => void }).prompt(
      prompt.name,
      prompt.description,
      promptArgs,
      async (args: Record<string, unknown>) => {
        return pipeline.getPrompt(prompt.name, args, ctx);
      },
    );
  }
}

function getPromptArgs(
  prompt: RegisteredPrompt,
): Record<string, { description: string; required: boolean }> {
  if (!prompt.parameters) return {};
  const descriptions = extractZodDescriptions(prompt.parameters);
  const args: Record<string, { description: string; required: boolean }> = {};
  for (const desc of descriptions) {
    args[desc.name] = {
      description: desc.description ?? '',
      required: desc.required,
    };
  }
  return args;
}
