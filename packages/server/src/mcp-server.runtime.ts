import { toNodeHandler } from "@modelcontextprotocol/node";
import {
	composeMcpMiddleware,
	createMcpLifecycleMiddleware,
	createMcpOperation,
	createMcpOperationContext,
} from "@nest-mcp/core";
import type { NodeMcpRequestHandler, ToNodeHandlerOptions } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type {
	AuthInfo,
	McpHandlerRequestOptions,
	McpHttpHandler,
	McpRequestContext,
	ServerEventBus,
	ServerNotifier,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ServeStdioOptions, StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { McpServerRuntimeError } from "./mcp-server.errors.ts";
import {
	applyMcpCorsHeaders,
	isMcpRequestSecured,
	limitMcpRequestBody,
	mcpHttpSecurityRejection,
	resolveMcpHttpSecurity,
} from "./security/mcp-http-security.ts";
import type { McpHttpSecurityPolicy } from "./security/mcp-http-security.ts";
import { withMcpNodeBodyLimit } from "./security/mcp-node-body-limit.ts";
import type {
	McpServerBuildContext,
	McpServerDefinition,
	McpServerOperationInput,
	McpServerOperationContext,
	McpServerPrincipal,
	McpServerPrincipalClaimsResolver,
	McpServerRuntimeEvent,
} from "./mcp-server.types.ts";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Owns one named MCP server definition and every HTTP/stdio serving lifecycle. */
export class McpServerRuntime implements AsyncDisposable {
	readonly name: string;
	readonly notify: ServerNotifier;
	readonly bus: ServerEventBus;
	/** Resolved HTTP security posture applied ahead of every HTTP dispatch. */
	readonly httpSecurity: McpHttpSecurityPolicy;

	readonly #definition: McpServerDefinition;
	readonly #handler: McpHttpHandler;
	readonly #shutdownTimeoutMs: number;
	readonly #stdioHandles = new Set<StdioServerHandle>();
	readonly #fetchTasks = new Set<Promise<Response>>();
	readonly #buildTasks = new Set<Promise<McpServer>>();
	readonly #principals = new WeakMap<AuthInfo, Promise<McpServerPrincipal>>();
	readonly #requestPipeline: (
		operation: ReturnType<typeof createServerRequestOperation>,
	) => Promise<Response>;
	#closePromise: Promise<void> | undefined;
	#closing = false;

	constructor(definition: McpServerDefinition) {
		assertDefinition(definition);
		this.#definition = {
			...definition,
			features: [...(definition.features ?? [])],
		};
		this.#shutdownTimeoutMs = definition.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.name = definition.name;
		this.httpSecurity = resolveMcpHttpSecurity(definition.httpSecurity);
		this.#handler = createMcpHandler((context) => this.createServer(context), {
			...definition.http,
			onerror: (error) => {
				this.#reportError(error);
				this.#observe({ phase: "handler:error", error });
			},
		});
		this.notify = this.#handler.notify;
		this.bus = this.#handler.bus;
		const middleware = [...(definition.middleware ?? [])];
		if (definition.lifecycleObserver !== undefined) {
			middleware.unshift(
				createMcpLifecycleMiddleware<McpServerOperationInput, Response, McpServerOperationContext>(
					definition.lifecycleObserver,
				),
			);
		}
		this.#requestPipeline = composeMcpMiddleware(middleware, (operation) => {
			this.#assertOpen();
			return this.#handler.fetch(operation.input.request, operation.input.options);
		});
	}

	/** Build the same server factory used by HTTP and stdio serving. */
	createServer(context: McpRequestContext): Promise<McpServer> {
		this.#assertOpen();
		const task = this.#buildServer(context);
		return trackTask(this.#buildTasks, task);
	}

	async #buildServer(context: McpRequestContext): Promise<McpServer> {
		const startedAt = performance.now();
		this.#observe({ phase: "build:start", era: context.era });
		let server: McpServer | undefined;
		try {
			const principal =
				context.authInfo === undefined ? undefined : await this.#resolvePrincipal(context.authInfo);
			// Principal projection may be asynchronous. Do not construct a new SDK
			// server after shutdown won that race.
			this.#assertOpen();
			server = new McpServer(this.#definition.serverInfo, this.#definition.serverOptions);
			const buildContext: McpServerBuildContext = {
				...context,
				runtimeName: this.name,
				...(principal === undefined ? {} : { principal }),
			};
			for (const feature of this.#definition.features ?? []) {
				await feature(server, buildContext);
				// A feature may await application work. Shutdown winning during that
				// await must roll the partially built SDK server back below.
				this.#assertOpen();
			}
			this.#assertOpen();
			this.#observe({
				phase: "build:success",
				era: context.era,
				durationMs: performance.now() - startedAt,
			});
			// Observers are isolated from protocol results, but they may synchronously
			// re-enter close(). Never hand a newly built SDK server out after that
			// ownership transition.
			this.#assertOpen();
			return server;
		} catch (cause) {
			let error = toError(cause);
			if (server !== undefined) {
				try {
					await server.close();
				} catch (closeError) {
					error = new AggregateError(
						[error, closeError],
						`MCP server runtime "${this.name}" failed to build and close its partial SDK server.`,
						{ cause: error },
					);
				}
			}
			this.#reportError(error);
			this.#observe({
				phase: "build:error",
				era: context.era,
				durationMs: performance.now() - startedAt,
				error,
			});
			throw error;
		}
	}

	fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		this.#assertOpen();
		const task = this.#serveHttp(request, options);
		return trackTask(this.#fetchTasks, task);
	}

	async #serveHttp(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		// An outer hardened facade (controller seam, hardenMcpFetch) already
		// gated this request under its own policy; defer to it entirely.
		if (isMcpRequestSecured(request)) {
			const operation = await this.#createRequestOperation(request, options);
			return this.#requestPipeline(operation);
		}
		// Security gating runs outside definition middleware and lifecycle
		// observation: a rejected request never reaches application composition.
		const rejection = mcpHttpSecurityRejection(request, this.httpSecurity);
		if (rejection !== undefined) {
			if (rejection.status >= 400) {
				this.#observe({ phase: "request:rejected", status: rejection.status });
			}
			return rejection;
		}
		const limited = await limitMcpRequestBody(request, this.httpSecurity);
		if (limited instanceof Response) {
			this.#observe({ phase: "request:rejected", status: limited.status });
			return applyMcpCorsHeaders(request, limited, this.httpSecurity);
		}
		const operation = await this.#createRequestOperation(limited, options);
		const response = await this.#requestPipeline(operation);
		return applyMcpCorsHeaders(request, response, this.httpSecurity);
	}

	toNodeHandler(options?: ToNodeHandlerOptions): NodeMcpRequestHandler {
		this.#assertOpen();
		// Adapt the runtime fetch face, not the raw SDK handler. This preserves
		// operation middleware, authorization, and lifecycle observation for
		// Express, Fastify, and plain Node hosts as well as web-standard hosts.
		// The Node-level body cap runs before the SDK converts the request,
		// where an unbounded stream would otherwise be buffered in full.
		return withMcpNodeBodyLimit(
			toNodeHandler(
				{
					fetch: (request, requestOptions) => this.fetch(request, requestOptions),
				},
				options,
			),
			this.httpSecurity,
			{ onRejected: (status) => this.reportRequestRejected(status) },
		);
	}

	/**
	 * Reports a pre-dispatch security rejection detected by an outer hardened
	 * layer (a Nest controller seam, a hand-composed facade) so it still surfaces
	 * as a `request:rejected` runtime observer event.
	 */
	reportRequestRejected(status: number): void {
		if (status >= 400) this.#observe({ phase: "request:rejected", status });
	}

	/** Start a stdio connection backed by this runtime's feature factory. */
	serveStdio(options?: Omit<ServeStdioOptions, "onerror">): StdioServerHandle {
		this.#assertOpen();
		const sdkHandle = serveStdio((context) => this.createServer(context), {
			...options,
			onerror: (error) => {
				this.#reportError(error);
				this.#observe({ phase: "handler:error", error });
			},
		});
		let closePromise: Promise<void> | undefined;
		let managedHandle: StdioServerHandle;
		managedHandle = Object.freeze({
			close: () => {
				closePromise ??= Promise.resolve()
					.then(() => sdkHandle.close())
					.finally(() => {
						this.#stdioHandles.delete(managedHandle);
					});
				return closePromise;
			},
		});
		this.#stdioHandles.add(managedHandle);
		return managedHandle;
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		// Publish the closing state and promise before observers, middleware, or
		// child handles can re-enter close().
		this.#closing = true;
		this.#closePromise = Promise.resolve().then(() => this.#performClose());
		return this.#closePromise;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async #performClose(): Promise<void> {
		const startedAt = performance.now();
		this.#observe({ phase: "close:start" });
		const servingTasks = [
			...[...this.#stdioHandles].map(async (handle) => handle.close()),
			this.#handler.close(),
		];
		const acceptedTasks = [...this.#fetchTasks, ...this.#buildTasks];
		const shutdownResult = await settleShutdownWithin(
			servingTasks,
			acceptedTasks,
			this.#shutdownTimeoutMs,
		);
		const failures = shutdownResult.servingSettled
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason as unknown);
		if (shutdownResult.timeoutError !== undefined) failures.push(shutdownResult.timeoutError);
		if (failures.length === 0) {
			this.#observe({
				phase: "close:success",
				durationMs: performance.now() - startedAt,
			});
			return;
		}
		const error = new AggregateError(
			failures,
			`MCP server runtime "${this.name}" failed to shut down cleanly.`,
		);
		this.#reportError(error);
		this.#observe({
			phase: "close:error",
			durationMs: performance.now() - startedAt,
			error,
		});
		throw error;
	}

	async #createRequestOperation(request: Request, options?: McpHandlerRequestOptions) {
		const principal =
			options?.authInfo === undefined ? undefined : await this.#resolvePrincipal(options.authInfo);
		// A slow claims resolver must not revive request dispatch after close().
		this.#assertOpen();
		return createServerRequestOperation(this.name, request, options, principal);
	}

	#resolvePrincipal(authInfo: AuthInfo): Promise<McpServerPrincipal> {
		const existing = this.#principals.get(authInfo);
		if (existing !== undefined) return existing;
		const pending = resolveMcpServerPrincipal(authInfo, this.#definition.principalClaims);
		this.#principals.set(authInfo, pending);
		void pending.catch(() => this.#principals.delete(authInfo));
		return pending;
	}

	#assertOpen(): void {
		if (this.#closing) {
			throw new McpServerRuntimeError(
				"RUNTIME_CLOSED",
				`MCP server runtime "${this.name}" is closed.`,
			);
		}
	}

	#reportError(error: Error): void {
		try {
			const result = this.#definition.onError?.(error);
			void Promise.resolve(result).catch(() => undefined);
		} catch {
			// Reporting must never change protocol behavior.
		}
	}

	#observe(event: Omit<McpServerRuntimeEvent, "runtimeName" | "timestamp">): void {
		try {
			const result = this.#definition.observer?.({
				...event,
				runtimeName: this.name,
				timestamp: Date.now(),
			});
			void Promise.resolve(result).catch(() => undefined);
		} catch {
			// Observability is deliberately isolated from the request path.
		}
	}
}

function assertDefinition(definition: McpServerDefinition): void {
	if (typeof definition !== "object" || definition === null) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP server definition must be an object.",
		);
	}
	if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP server name must be a non-empty string.",
		);
	}
	if (typeof definition.serverInfo !== "object" || definition.serverInfo === null) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP wire-level server info must be an object.",
		);
	}
	if (
		typeof definition.serverInfo.name !== "string" ||
		definition.serverInfo.name.trim().length === 0
	) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP wire-level server name must be a non-empty string.",
		);
	}
	if (
		typeof definition.serverInfo.version !== "string" ||
		definition.serverInfo.version.trim().length === 0
	) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP wire-level server version must be a non-empty string.",
		);
	}
	if (
		definition.shutdownTimeoutMs !== undefined &&
		(!Number.isFinite(definition.shutdownTimeoutMs) || definition.shutdownTimeoutMs <= 0)
	) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"MCP server shutdownTimeoutMs must be a positive finite number.",
		);
	}
}

function trackTask<Value>(tasks: Set<Promise<Value>>, task: Promise<Value>): Promise<Value> {
	tasks.add(task);
	void task.then(
		() => {
			tasks.delete(task);
		},
		() => {
			tasks.delete(task);
		},
	);
	return task;
}

async function settleShutdownWithin(
	servingTasks: readonly Promise<unknown>[],
	acceptedTasks: readonly Promise<unknown>[],
	timeoutMs: number,
): Promise<{
	readonly servingSettled: readonly PromiseSettledResult<unknown>[];
	readonly timeoutError?: Error;
}> {
	const observedServing: PromiseSettledResult<unknown>[] = [];
	const servingSettled = Promise.all(
		servingTasks.map(async (task) => {
			try {
				const value = await task;
				const result = { status: "fulfilled", value } as const;
				observedServing.push(result);
				return result;
			} catch (reason) {
				const result = { status: "rejected", reason } as const;
				observedServing.push(result);
				return result;
			}
		}),
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(resolve, timeoutMs, "timeout");
	});
	try {
		const result = await Promise.race([
			Promise.all([servingSettled, Promise.allSettled(acceptedTasks)]).then(([settled]) => ({
				kind: "settled" as const,
				servingSettled: settled,
			})),
			expired,
		]);
		if (result === "timeout") {
			return {
				servingSettled: observedServing,
				timeoutError: new Error(`MCP server shutdown timed out after ${String(timeoutMs)}ms.`),
			};
		}
		return { servingSettled: result.servingSettled };
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function createServerRequestOperation(
	runtimeName: string,
	request: Request,
	options?: McpHandlerRequestOptions,
	principal?: McpServerPrincipal,
) {
	const requestId = request.headers.get("x-request-id") ?? undefined;
	const sessionId = request.headers.get("mcp-session-id") ?? undefined;
	const context = createMcpOperationContext({
		operationId: requestId ?? crypto.randomUUID(),
		role: "server",
		operation: {
			name: "mcp.http",
			kind: "request",
			target: runtimeName,
			attributes: { "http.method": request.method },
		},
		signal: request.signal,
		...(requestId === undefined ? {} : { requestId }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(principal === undefined ? {} : { principal }),
	});
	return createMcpOperation(
		{
			request,
			...(options === undefined ? {} : { options }),
		},
		context,
	);
}

/** Projects verified auth data onto the deliberately narrow token-free principal contract. */
export async function resolveMcpServerPrincipal(
	authInfo: AuthInfo,
	resolveClaims?: McpServerPrincipalClaimsResolver,
): Promise<McpServerPrincipal> {
	const claims = resolveClaims === undefined ? undefined : await resolveClaims(authInfo);
	assertPrincipalClaims(claims);
	return Object.freeze({
		clientId: authInfo.clientId,
		scopes: Object.freeze([...authInfo.scopes]),
		...(authInfo.expiresAt === undefined ? {} : { expiresAt: authInfo.expiresAt }),
		...(authInfo.resource === undefined ? {} : { resource: authInfo.resource.href }),
		...(claims?.subject === undefined ? {} : { subject: claims.subject }),
		...(claims?.tenantId === undefined ? {} : { tenantId: claims.tenantId }),
	});
}

function assertPrincipalClaims(
	value: unknown,
): asserts value is { readonly subject?: string; readonly tenantId?: string } | undefined {
	if (value === undefined) return;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"principalClaims must resolve to a claims object.",
		);
	}
	for (const key of ["subject", "tenantId"] as const) {
		const claim = Reflect.get(value, key);
		if (claim !== undefined && (typeof claim !== "string" || claim.trim().length === 0)) {
			throw new McpServerRuntimeError(
				"INVALID_DEFINITION",
				`principalClaims.${key} must be a non-empty string when present.`,
			);
		}
	}
}
