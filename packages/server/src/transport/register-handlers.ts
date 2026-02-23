import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodToJsonSchema, extractZodDescriptions } from '@btwld/mcp-common';
import type { McpRegistryService } from '../discovery/registry.service';
import type { ExecutionPipelineService } from '../execution/pipeline.service';
import type { McpExecutionContext } from '@btwld/mcp-common';

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
    const inputSchema = tool.parameters ? getInputSchema(tool) : {};
    (server as any).tool(
      tool.name,
      tool.description,
      inputSchema,
      async (args: any) => {
        return pipeline.callTool(tool.name, args, ctx) as any;
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
    (server as any).resource(
      resource.name,
      resource.uri,
      resource.mimeType ? { mimeType: resource.mimeType } : {},
      async (uri: URL) => {
        return pipeline.readResource(uri.href, ctx) as any;
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
    (server as any).resource(
      template.name,
      template.uriTemplate,
      template.mimeType ? { mimeType: template.mimeType } : {},
      async (uri: URL) => {
        return pipeline.readResource(uri.href, ctx) as any;
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
    (server as any).prompt(
      prompt.name,
      prompt.description,
      promptArgs,
      async (args: any) => {
        return pipeline.getPrompt(prompt.name, args, ctx) as any;
      },
    );
  }
}

function getInputSchema(tool: any): Record<string, unknown> {
  if (!tool.parameters) return {};
  return zodToJsonSchema(tool.parameters);
}

function getPromptArgs(prompt: any): Record<string, any> {
  if (!prompt.parameters) return {};
  const descriptions = extractZodDescriptions(prompt.parameters);
  const args: Record<string, any> = {};
  for (const desc of descriptions) {
    args[desc.name] = {
      description: desc.description,
      required: desc.required,
    };
  }
  return args;
}
