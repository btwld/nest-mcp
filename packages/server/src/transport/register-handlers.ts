import { extractZodDescriptions } from '@btwld/mcp-common';
import type { McpExecutionContext } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CancelledNotificationSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
 * Map of active request IDs to their AbortControllers.
 * Used to cancel in-flight tool executions when a `notifications/cancelled`
 * notification is received from the client.
 */
const activeRequests = new Map<string | number, AbortController>();

/**
 * Registers all tools, resources, resource templates, and prompts from the
 * registry onto an McpServer instance, including parameter schemas, prompt
 * argument metadata, and resource mimeType information.
 *
 * Also registers:
 * - A `notifications/cancelled` handler for server-side request cancellation
 * - Custom list request handlers for cursor-based pagination
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
  registerCancellationHandler(server);
  registerListHandlers(server, pipeline);
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
      async (args: Record<string, unknown>, extra: { signal: AbortSignal; requestId: string | number }) => {
        // Create a local AbortController that is linked to the SDK's signal
        // and tracked in the activeRequests map for explicit cancellation.
        const controller = new AbortController();
        const requestId = extra.requestId;

        // Link the SDK's built-in signal to our controller
        if (extra.signal.aborted) {
          controller.abort();
        } else {
          extra.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        activeRequests.set(requestId, controller);

        // Shallow-clone the context with the cancellation signal
        const ctxWithSignal: McpExecutionContext = { ...ctx, signal: controller.signal };

        try {
          return await pipeline.callTool(tool.name, args, ctxWithSignal);
        } finally {
          activeRequests.delete(requestId);
        }
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

/**
 * Registers a `notifications/cancelled` handler on the low-level SDK Server
 * to abort in-flight tool executions when the client sends a cancellation.
 */
function registerCancellationHandler(server: McpServer): void {
  server.server.setNotificationHandler(
    CancelledNotificationSchema,
    async (notification) => {
      const requestId = notification.params?.requestId;
      if (requestId != null) {
        const controller = activeRequests.get(requestId);
        if (controller) {
          controller.abort();
          activeRequests.delete(requestId);
        }
      }
    },
  );
}

/**
 * Registers custom list request handlers on the low-level SDK Server to
 * support cursor-based pagination. These override the SDK's default
 * list handlers that were auto-registered by registerTool/resource/prompt.
 */
function registerListHandlers(
  server: McpServer,
  pipeline: ExecutionPipelineService,
): void {
  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await pipeline.listTools(cursor);
    return { tools: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await pipeline.listResources(cursor);
    return { resources: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await pipeline.listResourceTemplates(cursor);
    return {
      resourceTemplates: result.items,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  });

  server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await pipeline.listPrompts(cursor);
    return { prompts: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });
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
