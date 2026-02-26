import type { McpExecutionContext } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CancelledNotificationSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  McpRegistryService,
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../discovery/registry.service';
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

/** Handle returned by SDK registration methods — used to remove items dynamically. */
export interface SdkHandle {
  remove(): void;
}

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
  for (const tool of registry.getAllTools()) {
    registerToolOnServer(server, tool, pipeline, ctx);
  }
  for (const resource of registry.getAllResources()) {
    registerResourceOnServer(server, resource, pipeline, ctx);
  }
  for (const template of registry.getAllResourceTemplates()) {
    registerResourceTemplateOnServer(server, template, pipeline, ctx);
  }
  for (const prompt of registry.getAllPrompts()) {
    registerPromptOnServer(server, prompt, pipeline, ctx);
  }
  registerCancellationHandler(server);
  registerListHandlers(server, pipeline);
}

/**
 * Register a single tool on an McpServer instance.
 * Returns an SDK handle whose `remove()` unregisters the tool and auto-sends
 * `notifications/tools/list_changed` to connected clients.
 */
export function registerToolOnServer(
  server: McpServer,
  tool: RegisteredTool,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): SdkHandle {
  // Use registerTool() with named config to avoid overload ambiguity.
  // The SDK's tool() method uses isZodRawShapeCompat() to distinguish params
  // from annotations, which fails for pre-converted JSON schema objects.
  return (
    server as unknown as {
      registerTool: (...args: unknown[]) => SdkHandle;
    }
  ).registerTool(
    tool.name,
    {
      description: tool.description,
      // Use Zod schema for validation, or a permissive passthrough schema
      // for dynamically-registered tools that only have JSON schemas.
      // A schema is always required so the SDK passes args to the callback.
      inputSchema: tool.parameters ?? PASSTHROUGH_SCHEMA,
      outputSchema: tool.outputSchema,
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

/**
 * Register a single resource on an McpServer instance.
 * Returns an SDK handle whose `remove()` unregisters the resource.
 */
export function registerResourceOnServer(
  server: McpServer,
  resource: RegisteredResource,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): SdkHandle {
  return (
    server as unknown as {
      resource: (...args: unknown[]) => SdkHandle;
    }
  ).resource(
    resource.name,
    resource.uri,
    resource.mimeType ? { mimeType: resource.mimeType } : {},
    async (uri: URL) => {
      return pipeline.readResource(uri.href, ctx);
    },
  );
}

/**
 * Register a single resource template on an McpServer instance.
 * Returns an SDK handle whose `remove()` unregisters the template.
 */
export function registerResourceTemplateOnServer(
  server: McpServer,
  template: RegisteredResourceTemplate,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): SdkHandle {
  const resourceTemplate = new ResourceTemplate(template.uriTemplate, { list: undefined });
  return (
    server as unknown as {
      registerResource: (...args: unknown[]) => SdkHandle;
    }
  ).registerResource(
    template.name,
    resourceTemplate,
    template.mimeType ? { mimeType: template.mimeType } : {},
    async (uri: URL) => {
      return pipeline.readResource(uri.href, ctx);
    },
  );
}

/**
 * Register a single prompt on an McpServer instance.
 * Returns an SDK handle whose `remove()` unregisters the prompt.
 */
export function registerPromptOnServer(
  server: McpServer,
  prompt: RegisteredPrompt,
  pipeline: ExecutionPipelineService,
  ctx: McpExecutionContext,
): SdkHandle {
  return (
    server as unknown as {
      registerPrompt: (...args: unknown[]) => SdkHandle;
    }
  ).registerPrompt(
    prompt.name,
    {
      description: prompt.description,
      argsSchema: prompt.parameters?.shape,
    },
    async (args: Record<string, unknown>) => {
      return pipeline.getPrompt(prompt.name, args, ctx);
    },
  );
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
