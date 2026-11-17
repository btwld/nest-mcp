import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CancelTaskRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  McpError as SdkMcpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  ElicitRequest,
  ElicitResult,
  McpAuthInfo,
  McpExecutionContext,
  McpModuleOptions,
  McpProgress,
  ToolContent,
} from '@nest-mcp/common';
import { ValidationError, buildClientContext } from '@nest-mcp/common';
import { z } from 'zod';
import type {
  McpRegistryService,
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
  TaskHandlerConfig,
} from '../discovery/registry.service';
import { buildCreateMessage } from '../execution/context.factory';
import type { ExecutionPipelineService } from '../execution/pipeline.service';
import type { ResourceSubscriptionManager } from '../subscription/resource-subscription.manager';

/**
 * Permissive schema that accepts any arguments. Used for dynamically-registered
 * tools (e.g. gateway-proxied tools) that only have JSON schemas, not Zod schemas.
 * The MCP SDK requires a Zod schema to pass arguments to the handler callback.
 */
const PASSTHROUGH_SCHEMA = z.looseObject({});

/** Headers of the originating HTTP request, as surfaced by the SDK transport. */
interface RequestInfoLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Per-request auth/request surface of the SDK `RequestHandlerExtra`
 * (structural — `@nest-mcp/common` stays SDK-free). `authInfo` carries the
 * identity the HTTP edge attached to `req.auth`; `requestInfo` carries the
 * headers of the HTTP request that delivered this JSON-RPC message.
 */
interface RequestAuthExtra {
  authInfo?: McpAuthInfo;
  requestInfo?: RequestInfoLike;
}

/**
 * Builds a fresh per-request execution context from the SDK's per-request
 * `extra`. The session-level `ctx` captured at connect time would otherwise
 * go stale: on stateful transports every subsequent request reuses the
 * initialize-request's headers/identity. When the transport provides neither
 * `authInfo` nor `requestInfo` (SSE, STDIO), the context passes through
 * unchanged.
 */
function withRequestAuth(ctx: McpExecutionContext, extra: RequestAuthExtra): McpExecutionContext {
  if (!extra.authInfo && !extra.requestInfo) return ctx;
  const user = extra.authInfo
    ? {
        id: (extra.authInfo.extra?.sub as string) ?? extra.authInfo.clientId,
        scopes: extra.authInfo.scopes,
      }
    : ctx.user;
  return { ...ctx, request: extra.requestInfo ?? ctx.request, authInfo: extra.authInfo, user };
}

/**
 * Per-request context carrying the SDK's abort signal. The SDK aborts it when
 * the client sends `notifications/cancelled` for this request (scoped to the
 * session that owns the request) and then suppresses the response, so no
 * cancellation bookkeeping is needed here.
 */
function withSignal(ctx: McpExecutionContext, extra: { signal: AbortSignal }): McpExecutionContext {
  return { ...ctx, signal: extra.signal };
}

/**
 * The SDK surfaces a "URL elicitation required" failure as a JSON-RPC error
 * (code -32042) only for its own error class; anything else thrown from a tool
 * becomes an `isError` result. Convert errors carrying that code so handlers
 * can raise it with any error type.
 */
function asUrlElicitationRequired(error: unknown): unknown {
  if (error instanceof SdkMcpError) return error;
  const candidate = error as { code?: unknown; message?: unknown; data?: unknown } | null;
  if (candidate?.code !== ErrorCode.UrlElicitationRequired) return error;
  return new SdkMcpError(
    ErrorCode.UrlElicitationRequired,
    typeof candidate.message === 'string' ? candidate.message : 'URL elicitation required',
    candidate.data,
  );
}

/**
 * The SDK installs its `tools/call`, `resources/read` and `prompts/get`
 * handlers lazily, on the first registration of each kind. Install them up
 * front for every declared capability: a capability that starts empty then
 * still answers calls once items are registered dynamically, and that first
 * dynamic registration no longer collides with the list handlers installed by
 * {@link registerListHandlers}.
 */
function initializeSdkHandlers(
  server: McpServer,
  declared: { tools: boolean; resources: boolean; prompts: boolean },
): void {
  const sdk = server as unknown as {
    setToolRequestHandlers?: () => void;
    setResourceRequestHandlers?: () => void;
    setPromptRequestHandlers?: () => void;
  };
  if (declared.tools) sdk.setToolRequestHandlers?.();
  if (declared.resources) sdk.setResourceRequestHandlers?.();
  if (declared.prompts) sdk.setPromptRequestHandlers?.();
}

/** Capabilities the server declares, from registered items or explicit options. */
function declaredCapabilities(registry: McpRegistryService, options: McpModuleOptions) {
  return {
    tools: registry.hasTools || !!options.capabilities?.tools,
    resources:
      registry.hasResources || registry.hasResourceTemplates || !!options.capabilities?.resources,
    prompts: registry.hasPrompts || !!options.capabilities?.prompts,
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
 * Also registers custom list request handlers for cursor-based pagination.
 * Cancellation is left to the SDK, which aborts the per-request signal.
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
  initializeSdkHandlers(server, declaredCapabilities(registry, options));
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
  registerListHandlers(server, pipeline, registry, options, ctx);
  registerCompletionHandler(server, pipeline, registry, options, ctx);
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
      extra: RequestAuthExtra & {
        signal: AbortSignal;
        requestId: string | number;
        _meta?: { progressToken?: string | number };
        sendNotification?: (notification: {
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      },
    ) => {
      // Fresh spread per call: the pipeline's user write-back stays
      // request-isolated instead of mutating the shared session context.
      const requestCtx = withSignal(withRequestAuth(ctx, extra), extra);

      // Build per-request reportProgress that sends notifications/progress
      // when the client provided a progressToken in _meta. Progress must
      // increase and must stop once the request has completed.
      const progressToken = extra._meta?.progressToken;
      let finished = false;
      let lastProgress = Number.NEGATIVE_INFINITY;
      const reportProgress =
        progressToken != null && extra.sendNotification
          ? async (progress: McpProgress) => {
              if (finished || !(progress.progress > lastProgress)) return;
              lastProgress = progress.progress;
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

      // Server-to-client requests made while handling this call are tied to
      // it (`relatedRequestId`): Streamable HTTP then delivers them on this
      // call's response stream instead of the optional standalone GET stream,
      // where they would be dropped when the client has not opened one.
      const related = { relatedRequestId: extra.requestId, signal: extra.signal };

      // Build per-request elicit that delegates to the SDK's elicitInput method
      const elicit = (params: ElicitRequest, options?: { signal?: AbortSignal }) =>
        server.server.elicitInput(params as Parameters<typeof server.server.elicitInput>[0], {
          ...related,
          ...(options?.signal ? { signal: options.signal } : {}),
        }) as Promise<ElicitResult>;

      const ctxWithSignal: McpExecutionContext = {
        ...requestCtx,
        reportProgress,
        ...(streamContent ? { streamContent } : {}),
        elicit,
        ...(requestCtx.createMessage ? { createMessage: buildCreateMessage(server, related) } : {}),
      };

      try {
        return await pipeline.callTool(tool.name, args, ctxWithSignal);
      } catch (error) {
        throw asUrlElicitationRequired(error);
      } finally {
        finished = true;
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
    async (
      uri: URL,
      extra: RequestAuthExtra & { signal: AbortSignal; requestId: string | number },
    ) => {
      return pipeline.readResource(uri.href, withSignal(withRequestAuth(ctx, extra), extra));
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
      extra: RequestAuthExtra & { signal: AbortSignal; requestId: string | number },
    ) => {
      return pipeline.readResource(uri.href, withSignal(withRequestAuth(ctx, extra), extra));
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
  type PromptExtra = RequestAuthExtra & { signal: AbortSignal; requestId: string | number };
  const handle = (
    server as unknown as {
      registerPrompt: (...args: unknown[]) => SdkHandle & { argsSchema?: unknown };
    }
  ).registerPrompt(
    prompt.name,
    {
      description: prompt.description,
      argsSchema: prompt.parameters?.shape,
    },
    // The SDK invokes `cb(args, extra)` for prompts that have an args schema
    // and `cb(extra)` for prompts that do not.
    async (...callbackArgs: [Record<string, unknown>, PromptExtra] | [PromptExtra]) => {
      const [args, extra] =
        callbackArgs.length > 1
          ? (callbackArgs as [Record<string, unknown>, PromptExtra])
          : [{}, callbackArgs[0] as PromptExtra];
      return pipeline.getPrompt(prompt.name, args, withSignal(withRequestAuth(ctx, extra), extra));
    },
  );
  // Prompts without a Zod schema (no parameters, or dynamically registered
  // with raw argument metadata) still receive the caller's arguments: give
  // the SDK a permissive schema so it forwards them instead of dropping them.
  if (!prompt.parameters && handle) {
    handle.argsSchema = PASSTHROUGH_SCHEMA;
  }
  return handle;
}

/**
 * Loose per-request view of the SDK `RequestHandlerExtra` for typed
 * `setRequestHandler` callbacks. Wider than {@link RequestAuthExtra} so the
 * SDK's concrete `AuthInfo` (whose `resource` is a `URL`) stays assignable.
 */
interface ListHandlerExtra {
  authInfo?: { scopes?: string[] };
  requestInfo?: RequestInfoLike;
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
  ctx: McpExecutionContext,
): void {
  const declared = declaredCapabilities(registry, options);

  if (declared.tools) {
    server.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra?: ListHandlerExtra) => {
        const cursor = request.params?.cursor;
        const clientContext = buildClientContext({
          transport: ctx.transport,
          request: extra?.requestInfo ?? ctx.request,
        });
        const result = await pipeline.listTools(cursor, clientContext, {
          scopes: extra?.authInfo?.scopes,
        });
        return {
          tools: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
    );
  }

  if (declared.resources) {
    server.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request, extra?: ListHandlerExtra) => {
        const cursor = request.params?.cursor;
        const result = await pipeline.listResources(cursor, { scopes: extra?.authInfo?.scopes });
        return {
          resources: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
    );

    server.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request, extra?: ListHandlerExtra) => {
        const cursor = request.params?.cursor;
        const result = await pipeline.listResourceTemplates(cursor, {
          scopes: extra?.authInfo?.scopes,
        });
        return {
          resourceTemplates: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
    );
  }

  if (declared.prompts) {
    server.server.setRequestHandler(
      ListPromptsRequestSchema,
      async (request, extra?: ListHandlerExtra) => {
        const cursor = request.params?.cursor;
        const result = await pipeline.listPrompts(cursor, { scopes: extra?.authInfo?.scopes });
        return {
          prompts: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
    );
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
  ctx: McpExecutionContext,
): void {
  const hasCompletions =
    registry.hasPrompts ||
    registry.hasResourceTemplates ||
    !!options.capabilities?.prompts ||
    !!options.capabilities?.resources;

  if (!hasCompletions) return;

  server.server.setRequestHandler(
    CompleteRequestSchema,
    async (request, extra?: ListHandlerExtra) => {
      // Per-request context so request-scoped completion providers receive the
      // caller's request, the same as tools, resources and prompts. `authInfo`
      // is the `McpAuthInfo` the HTTP edge attached to `req.auth`.
      const requestCtx = withRequestAuth(ctx, (extra ?? {}) as RequestAuthExtra);
      const result = await pipeline.complete(
        {
          ref: request.params.ref,
          argument: request.params.argument,
          context: request.params.context,
        },
        requestCtx,
      );
      return {
        completion: {
          values: result.values,
          ...(result.hasMore != null ? { hasMore: result.hasMore } : {}),
          ...(result.total != null ? { total: result.total } : {}),
        },
      };
    },
  );
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
    if (!task) throw new ValidationError(`Task "${request.params.taskId}" not found`);
    return task;
  });

  server.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const task = await config.cancelTask(request.params.taskId);
    if (!task) throw new ValidationError(`Task "${request.params.taskId}" not found`);
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
