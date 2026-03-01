import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CancelTaskRequestSchema,
  CancelledNotificationSchema,
  CompleteRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  ElicitRequest,
  ElicitResult,
  McpExecutionContext,
  McpModuleOptions,
  McpProgress,
  ToolContent,
} from '@nest-mcp/common';
import { z } from 'zod';
import type {
  McpRegistryService,
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
  TaskHandlerConfig,
} from '../discovery/registry.service';
import type { ExecutionPipelineService } from '../execution/pipeline.service';
import type { ResourceSubscriptionManager } from '../subscription/resource-subscription.manager';

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

function createSignalContext(
  ctx: McpExecutionContext,
  extra: { signal: AbortSignal; requestId: string | number },
): { ctxWithSignal: McpExecutionContext; cleanup: () => void } {
  const controller = new AbortController();
  if (extra.signal.aborted) {
    controller.abort();
  } else {
    extra.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  activeRequests.set(extra.requestId, controller);
  return {
    ctxWithSignal: { ...ctx, signal: controller.signal },
    cleanup: () => activeRequests.delete(extra.requestId),
  };
}

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
  options: McpModuleOptions,
  subscriptionManager?: ResourceSubscriptionManager,
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
  registerListHandlers(server, pipeline, registry, options);
  registerCompletionHandler(server, pipeline, registry, options);
  if (subscriptionManager) {
    registerSubscriptionHandlers(server, subscriptionManager, ctx);
  }
  if (registry.taskHandlerConfig && options.capabilities?.tasks?.enabled) {
    registerTaskProxyHandlers(server, registry.taskHandlerConfig);
  }
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
    async (
      args: Record<string, unknown>,
      extra: {
        signal: AbortSignal;
        requestId: string | number;
        _meta?: { progressToken?: string | number };
        sendNotification?: (notification: {
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      },
    ) => {
      const { ctxWithSignal: baseCtxWithSignal, cleanup } = createSignalContext(ctx, extra);

      // Build per-request reportProgress that sends notifications/progress
      // when the client provided a progressToken in _meta
      const progressToken = extra._meta?.progressToken;
      const reportProgress =
        progressToken != null && extra.sendNotification
          ? async (progress: McpProgress) => {
              await extra.sendNotification?.({
                method: 'notifications/progress' as const,
                params: {
                  progressToken,
                  progress: progress.progress,
                  ...(progress.total != null ? { total: progress.total } : {}),
                  ...(progress.message != null ? { message: progress.message } : {}),
                },
              });
            }
          : ctx.reportProgress;

      // Build per-request streamContent that sends notifications/tool/streamContent
      const streamContent = extra.sendNotification
        ? async (content: ToolContent | ToolContent[]) => {
            await extra.sendNotification?.({
              method: 'notifications/tool/streamContent',
              params: {
                toolName: tool.name,
                content: Array.isArray(content) ? content : [content],
              },
            });
          }
        : undefined;

      // Build per-request elicit that delegates to the SDK's elicitInput method
      const elicit = (params: ElicitRequest, options?: { signal?: AbortSignal }) =>
        server.server.elicitInput(
          params as Parameters<typeof server.server.elicitInput>[0],
          options,
        ) as Promise<ElicitResult>;

      const ctxWithSignal: McpExecutionContext = {
        ...baseCtxWithSignal,
        reportProgress,
        ...(streamContent ? { streamContent } : {}),
        elicit,
      };

      try {
        return await pipeline.callTool(tool.name, args, ctxWithSignal);
      } finally {
        cleanup();
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
    async (uri: URL, extra: { signal: AbortSignal; requestId: string | number }) => {
      const { ctxWithSignal, cleanup } = createSignalContext(ctx, extra);
      try {
        return await pipeline.readResource(uri.href, ctxWithSignal);
      } finally {
        cleanup();
      }
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
    async (
      uri: URL,
      _variables: Record<string, string>,
      extra: { signal: AbortSignal; requestId: string | number },
    ) => {
      const { ctxWithSignal, cleanup } = createSignalContext(ctx, extra);
      try {
        return await pipeline.readResource(uri.href, ctxWithSignal);
      } finally {
        cleanup();
      }
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
    async (
      args: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId: string | number },
    ) => {
      const { ctxWithSignal, cleanup } = createSignalContext(ctx, extra);
      try {
        return await pipeline.getPrompt(prompt.name, args, ctxWithSignal);
      } finally {
        cleanup();
      }
    },
  );
}

/**
 * Registers a `notifications/cancelled` handler on the low-level SDK Server
 * to abort in-flight tool executions when the client sends a cancellation.
 */
function registerCancellationHandler(server: McpServer): void {
  server.server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
    const requestId = notification.params?.requestId;
    if (requestId != null) {
      const controller = activeRequests.get(requestId);
      if (controller) {
        controller.abort();
        activeRequests.delete(requestId);
      }
    }
  });
}

/**
 * Registers custom list request handlers on the low-level SDK Server to
 * support cursor-based pagination. These override the SDK's default
 * list handlers that were auto-registered by registerTool/resource/prompt.
 *
 * Only registers handlers for capabilities the server actually declared —
 * the MCP SDK (v1.26+) throws if you register a handler for an undeclared capability.
 */
function registerListHandlers(
  server: McpServer,
  pipeline: ExecutionPipelineService,
  registry: McpRegistryService,
  options: McpModuleOptions,
): void {
  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await pipeline.listTools(cursor);
    return { tools: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  const hasResources =
    registry.hasResources || registry.hasResourceTemplates || !!options.capabilities?.resources;

  if (hasResources) {
    server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      const result = await pipeline.listResources(cursor);
      return {
        resources: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });

    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      const result = await pipeline.listResourceTemplates(cursor);
      return {
        resourceTemplates: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });
  }

  const hasPrompts = registry.hasPrompts || !!options.capabilities?.prompts;

  if (hasPrompts) {
    server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      const result = await pipeline.listPrompts(cursor);
      return {
        prompts: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });
  }
}

/**
 * Registers a `completion/complete` handler on the low-level SDK Server.
 * Only registered when the server declares completions capability (which requires
 * prompts or resource templates). The MCP SDK enforces this at registration time.
 */
function registerCompletionHandler(
  server: McpServer,
  pipeline: ExecutionPipelineService,
  registry: McpRegistryService,
  options: McpModuleOptions,
): void {
  const hasCompletions =
    registry.hasPrompts ||
    registry.hasResourceTemplates ||
    !!options.capabilities?.prompts ||
    !!options.capabilities?.resources;

  if (!hasCompletions) return;

  server.server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const result = await pipeline.complete({
      ref: request.params.ref,
      argument: request.params.argument,
      context: request.params.context,
    });
    return {
      completion: {
        values: result.values,
        ...(result.hasMore != null ? { hasMore: result.hasMore } : {}),
        ...(result.total != null ? { total: result.total } : {}),
      },
    };
  });
}

/**
 * Registers task protocol proxy handlers on the low-level SDK Server.
 * Used by the gateway to forward tasks/list, tasks/get, tasks/cancel, and
 * tasks/result to the appropriate upstream server.
 *
 * Only called when `registry.taskHandlerConfig` is set (gateway mode) and
 * the server has declared `tasks.enabled` capability.
 */
function registerTaskProxyHandlers(server: McpServer, config: TaskHandlerConfig): void {
  server.server.setRequestHandler(ListTasksRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await config.listTasks(cursor);
    return { tasks: result.tasks, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });

  server.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    const task = await config.getTask(request.params.taskId);
    if (!task) throw new Error(`Task "${request.params.taskId}" not found`);
    return task;
  });

  server.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const task = await config.cancelTask(request.params.taskId);
    if (!task) throw new Error(`Task "${request.params.taskId}" not found`);
    return task;
  });

  server.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
    return config.getTaskPayload(request.params.taskId);
  });
}

/**
 * Registers `resources/subscribe` and `resources/unsubscribe` request handlers
 * on the low-level SDK Server for per-session resource change tracking.
 */
function registerSubscriptionHandlers(
  server: McpServer,
  manager: ResourceSubscriptionManager,
  ctx: McpExecutionContext,
): void {
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    manager.subscribe(ctx.sessionId, request.params.uri, server);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    manager.unsubscribe(ctx.sessionId, request.params.uri);
    return {};
  });
}
