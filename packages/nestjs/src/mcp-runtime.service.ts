import {
	Inject,
	Injectable,
	Optional,
	type OnApplicationBootstrap,
	type OnModuleDestroy,
} from "@nestjs/common";
import { McpClientRuntime } from "@nest-mcp/client";
import {
	McpGateway,
	bindMcpGatewayMiddleware,
	createMcpClientRuntimeUpstream,
} from "@nest-mcp/gateway";
import type { McpGatewayPolicy } from "@nest-mcp/gateway";
import { McpServerRegistry, type McpServerFeature, type McpServerRuntime } from "@nest-mcp/server";
import { McpCapabilitiesService } from "./mcp-capabilities.service.ts";
import type { McpCatalogExposurePolicy } from "./mcp-catalog-exposure.ts";
import { McpModuleError } from "./mcp.errors.ts";
import { McpProviderRegistry, mcpProviderTokenName } from "./mcp-provider.registry.ts";
import type { McpProviderToken } from "./mcp-provider.types.ts";
import { assertMcpCatalogExposureOptions } from "./mcp-catalog.runtime.ts";
import { MCP_MODULE_OPTIONS } from "./mcp.tokens.ts";
import type {
	McpHandlerAuthorizationPolicy,
	McpHandlerLifecycleObserver,
	McpHandlerMiddlewareProvider,
	McpGatewayAuthorizationContextProvider,
	McpGatewayClientProvider,
	McpGatewayLifecycleObserverProvider,
	McpGatewayMiddlewareProvider,
	McpGatewayObserverErrorReporter,
	McpModuleOptions,
	McpNestGatewayOptions,
	McpNestGatewayUpstreamDefinition,
	McpServerContributor,
	McpServerErrorReporter,
	McpServerLifecycleObserver,
	McpServerMiddlewareProvider,
	McpServerPrincipalClaimsProvider,
	McpServerRuntimeObserverProvider,
} from "./mcp.types.ts";
import { McpHandlerExplorer } from "./discovery/mcp-handler.explorer.ts";
import { McpHandlerRegistry } from "./discovery/mcp-handler.registry.ts";
import { McpClientService } from "./client/mcp-client.service.ts";
import {
	resolveMcpNestServerHttpOptions,
	resolveMcpNestServerOptions,
} from "./server/mcp-server-options.ts";
import { resolveMcpNestServerOAuth } from "./oauth/mcp-oauth-options.ts";
import type { McpFetchHandler } from "@nest-mcp/server/auth";
import type { McpOAuthProxy } from "@nest-mcp/auth";

@Injectable()
export class McpRuntimeService implements OnApplicationBootstrap, OnModuleDestroy {
	#ready = false;
	readonly #gateways = new Map<string, McpGateway>();
	readonly #httpComposers = new Map<string, (handler: McpFetchHandler) => McpFetchHandler>();
	readonly #oauthProxies = new Map<string, McpOAuthProxy>();
	#closeTask: Promise<void> | undefined;
	#shutdownError: AggregateError | undefined;
	#unsubscribeCapabilityMutations: (() => void) | undefined;

	constructor(
		@Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
		@Inject(McpClientService)
		@Optional()
		private readonly clientService: McpClientService | undefined,
		private readonly servers: McpServerRegistry,
		private readonly explorer: McpHandlerExplorer,
		private readonly handlerRegistry: McpHandlerRegistry,
		/** Public live-capability service used by future request server builds. */
		readonly capabilities: McpCapabilitiesService,
		private readonly providers: McpProviderRegistry,
	) {}

	async onApplicationBootstrap(): Promise<void> {
		try {
			this.explorer.assertSingleRoot();
			if (this.options.autoDiscover !== false) this.explorer.scan();
			const definitions = this.options.servers ?? [];
			for (const definition of definitions) {
				if (definition.catalogExposure === undefined) continue;
				if (
					typeof definition.catalogExposure !== "object" ||
					definition.catalogExposure === null ||
					definition.catalogExposure.policy === undefined
				) {
					throw new McpModuleError(
						"INVALID_CATALOG_EXPOSURE",
						`MCP catalog exposure for server "${definition.name}" requires a policy provider token.`,
					);
				}
				if (definition.gateway !== undefined) {
					throw new McpModuleError(
						"INVALID_CATALOG_EXPOSURE",
						`MCP catalog exposure cannot be combined with gateway server "${definition.name}".`,
					);
				}
				if ((definition.contributors?.length ?? 0) > 0) {
					throw new McpModuleError(
						"INVALID_CATALOG_EXPOSURE",
						`MCP catalog exposure for server "${definition.name}" cannot safely project tools from custom contributors. Register cataloged tools through decorators or McpCapabilitiesService.`,
					);
				}
			}
			this.handlerRegistry.configureRuntimes(
				definitions.map(({ name }) => name),
				definitions.flatMap(({ name, gateway }) =>
					gateway === undefined || gateway.composition === "tools" ? [] : [name],
				),
				definitions.flatMap(({ name, catalogExposure }) =>
					catalogExposure === undefined ? [] : [name],
				),
			);
			const oauthRouteOwners = new Map<string, string>();
			for (const definition of definitions) {
				const {
					catalogExposure,
					contributors: contributorTokens,
					gateway,
					handlerAuthorization: handlerAuthorizationToken,
					handlerLifecycleObserver: handlerLifecycleObserverToken,
					handlerMiddleware: handlerMiddlewareTokens,
					handlerVisibilityTimeoutMs,
					http: httpOptions,
					lifecycleObserver: lifecycleObserverToken,
					middleware: middlewareTokens,
					oauth: oauthOptions,
					observer: observerToken,
					onError: errorReporterToken,
					principalClaims: principalClaimsToken,
					serverOptions,
					...serverDefinition
				} = definition;
				Reflect.deleteProperty(serverDefinition, "features");
				const resolvedOAuth = resolveMcpNestServerOAuth(
					oauthOptions,
					this.providers,
					definition.name,
				);
				if (resolvedOAuth !== undefined) {
					this.#httpComposers.set(definition.name, resolvedOAuth.compose);
					if (resolvedOAuth.proxy !== undefined) {
						const proxy = resolvedOAuth.proxy;
						// Two proxies sharing an issuer+basePath would silently shadow each
						// other's identical routes; refuse the ambiguous configuration.
						const route = `${proxy.authorizationServerMetadata.issuer}${proxy.basePath}`;
						const owner = oauthRouteOwners.get(route);
						if (owner !== undefined) {
							throw new McpModuleError(
								"INVALID_OPTIONS",
								`MCP servers "${owner}" and "${definition.name}" both expose an OAuth proxy at "${route}". Give each a distinct issuer or oauth.proxy.basePath.`,
							);
						}
						oauthRouteOwners.set(route, definition.name);
						this.#oauthProxies.set(definition.name, proxy);
					}
				}
				const resolvedServerOptions = resolveMcpNestServerOptions(serverOptions, this.providers);
				const resolvedHttpOptions = resolveMcpNestServerHttpOptions(httpOptions, this.providers);
				const contributors = this.#providerTokenList(
					contributorTokens,
					definition.name,
					"contributors",
				).map((token) =>
					this.#resolveProvider<McpServerContributor>(
						token,
						definition.name,
						"contributor",
						"contribute",
					),
				);
				const catalogPolicy =
					catalogExposure === undefined
						? undefined
						: this.#resolveProvider<McpCatalogExposurePolicy>(
								catalogExposure.policy,
								definition.name,
								"catalog exposure policy",
								"resolve",
							);
				const resolvedCatalogExposure =
					catalogPolicy === undefined
						? undefined
						: Object.freeze({
								resolver: (input: Parameters<McpCatalogExposurePolicy["resolve"]>[0]) =>
									catalogPolicy.resolve(input),
							});
				if (resolvedCatalogExposure !== undefined) {
					assertMcpCatalogExposureOptions(resolvedCatalogExposure, definition.name);
				}
				const handlerAuthorization =
					handlerAuthorizationToken === undefined
						? undefined
						: this.#resolveProvider<McpHandlerAuthorizationPolicy>(
								handlerAuthorizationToken,
								definition.name,
								"handler authorization policy",
								"authorize",
							);
				const handlerMiddleware = this.#providerTokenList(
					handlerMiddlewareTokens,
					definition.name,
					"handlerMiddleware",
				).map((token) => {
					const provider = this.#resolveProvider<McpHandlerMiddlewareProvider>(
						token,
						definition.name,
						"handler middleware",
						"handle",
					);
					return provider.handle.bind(provider);
				});
				const handlerLifecycleObserver =
					handlerLifecycleObserverToken === undefined
						? undefined
						: this.#resolveProvider<McpHandlerLifecycleObserver>(
								handlerLifecycleObserverToken,
								definition.name,
								"handler lifecycle observer",
								"onEvent",
							);
				const principalClaimsProvider =
					principalClaimsToken === undefined
						? undefined
						: this.#resolveProvider<McpServerPrincipalClaimsProvider>(
								principalClaimsToken,
								definition.name,
								"principal claims provider",
								"resolvePrincipalClaims",
							);
				const middleware = this.#providerTokenList(
					middlewareTokens,
					definition.name,
					"middleware",
				).map((token) => {
					const provider = this.#resolveProvider<McpServerMiddlewareProvider>(
						token,
						definition.name,
						"server middleware",
						"handle",
					);
					return provider.handle.bind(provider);
				});
				const lifecycleObserver =
					lifecycleObserverToken === undefined
						? undefined
						: this.#resolveProvider<McpServerLifecycleObserver>(
								lifecycleObserverToken,
								definition.name,
								"server lifecycle observer",
								"onEvent",
							);
				const runtimeObserver =
					observerToken === undefined
						? undefined
						: this.#resolveProvider<McpServerRuntimeObserverProvider>(
								observerToken,
								definition.name,
								"server runtime observer",
								"observe",
							);
				const errorReporter =
					errorReporterToken === undefined
						? undefined
						: this.#resolveProvider<McpServerErrorReporter>(
								errorReporterToken,
								definition.name,
								"server error reporter",
								"report",
							);
				if (
					gateway !== undefined &&
					gateway.composition !== "tools" &&
					(this.handlerRegistry.hasHandlersFor(definition.name) || contributors.length > 0)
				) {
					throw new McpModuleError(
						"INVALID_OPTIONS",
						`MCP gateway server "${definition.name}" must be dedicated and cannot also host decorated or contributed capabilities.`,
					);
				}
				const discovered = this.handlerRegistry.asServerFeature({
					serverName: definition.name,
					...(resolvedCatalogExposure === undefined
						? {}
						: { catalogExposure: resolvedCatalogExposure }),
					...(handlerAuthorization === undefined ? {} : { authorization: handlerAuthorization }),
					...(handlerMiddleware.length === 0 ? {} : { middleware: handlerMiddleware }),
					...(handlerLifecycleObserver === undefined
						? {}
						: { lifecycleObserver: handlerLifecycleObserver }),
					...(handlerVisibilityTimeoutMs === undefined
						? {}
						: { visibilityTimeoutMs: handlerVisibilityTimeoutMs }),
				});
				const features: McpServerFeature[] = [];
				// Discovery may be disabled while live registry APIs remain enabled.
				// Install projected tools first so the SDK owns the shared tools handlers.
				if (gateway?.composition === "tools") {
					features.push(this.#createGatewayFeature(definition.name, gateway));
				}
				if (gateway === undefined || gateway.composition === "tools") features.push(discovered);
				if (contributors.length > 0) {
					features.push(async (server, context) => {
						for (const contributor of contributors) await contributor.contribute(server, context);
					});
				}
				if (gateway !== undefined && gateway.composition !== "tools") {
					features.push(this.#createGatewayFeature(definition.name, gateway));
				}
				this.servers.register({
					...serverDefinition,
					...(resolvedServerOptions === undefined ? {} : { serverOptions: resolvedServerOptions }),
					...(resolvedHttpOptions === undefined ? {} : { http: resolvedHttpOptions }),
					...(principalClaimsProvider === undefined
						? {}
						: {
								principalClaims: (authInfo) =>
									principalClaimsProvider.resolvePrincipalClaims(authInfo),
							}),
					...(middleware.length === 0 ? {} : { middleware }),
					...(lifecycleObserver === undefined ? {} : { lifecycleObserver }),
					...(runtimeObserver === undefined
						? {}
						: { observer: (event) => runtimeObserver.observe(event) }),
					...(errorReporter === undefined
						? {}
						: { onError: (error) => errorReporter.report(error) }),
					...(features.length === 0 ? {} : { features }),
				});
			}
			this.#unsubscribeCapabilityMutations = this.handlerRegistry.onMutation(
				({ kind, serverNames }) => {
					for (const serverName of serverNames) {
						try {
							const notifier = this.servers.get(serverName).notify;
							if (kind === "tool") notifier.toolsChanged();
							else if (kind === "prompt") notifier.promptsChanged();
							else notifier.resourcesChanged();
						} catch {
							// A committed registry mutation remains valid if publication races shutdown.
						}
					}
				},
			);
			this.#ready = true;
		} catch (bootstrapError) {
			try {
				await this.close();
			} catch (cleanupError) {
				// Both caught failures are retained explicitly in AggregateError.errors.
				// oxlint-disable-next-line eslint/preserve-caught-error
				throw new AggregateError(
					[bootstrapError, cleanupError],
					"MCP bootstrap failed and its partially initialized runtimes could not close cleanly.",
					{ cause: bootstrapError },
				);
			}
			throw bootstrapError;
		}
	}

	/**
	 * Composes the configured OAuth resource-server protection around a runtime's
	 * fetch handler. Returns the runtime untouched when the server has no `oauth`
	 * group, so the HTTP controller's default composition seam is a no-op unless
	 * OAuth is configured.
	 */
	composeHttpHandler(serverName: string, runtime: McpServerRuntime): McpFetchHandler {
		const composer = this.#httpComposers.get(serverName);
		return composer === undefined ? runtime : composer(runtime);
	}

	/** The OAuth authorization-server proxy for a server, when `oauth.proxy` is configured. */
	oauthProxy(serverName: string): McpOAuthProxy | undefined {
		return this.#oauthProxies.get(serverName);
	}

	server(name: string): McpServerRuntime {
		this.#assertReady();
		return this.servers.get(name);
	}

	client(name: string): ReturnType<McpClientRuntime["requireClient"]> {
		this.#assertReady();
		return this.clients.requireClient(name);
	}

	/** Named client runtime imported through `McpClientModule`. */
	get clients(): McpClientRuntime {
		if (this.clientService === undefined) {
			throw new McpModuleError(
				"UNKNOWN_CLIENT",
				"No McpClientModule is imported by this MCP root.",
			);
		}
		return this.clientService;
	}

	/** Returns the aggregate gateway owned by one configured inbound server. */
	gateway(serverName: string): McpGateway {
		this.#assertReady();
		const gateway = this.#gateways.get(serverName);
		if (gateway === undefined) {
			throw new McpModuleError(
				"UNKNOWN_GATEWAY",
				`No MCP gateway is configured for server "${serverName}".`,
			);
		}
		return gateway;
	}

	listGateways(): readonly McpGateway[] {
		this.#assertReady();
		return Object.freeze([...this.#gateways.values()]);
	}

	isReady(): boolean {
		return this.#ready;
	}

	/** Last cleanup failure contained by the Nest lifecycle hook, if any. */
	get shutdownError(): AggregateError | undefined {
		return this.#shutdownError;
	}

	/** Explicit shutdown API. Unlike the Nest hook, this rejects on cleanup failure. */
	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#ready = false;
		this.#closeTask = Promise.resolve().then(() => this.#performClose());
		return this.#closeTask;
	}

	async onModuleDestroy(): Promise<void> {
		try {
			await this.close();
		} catch {
			// Nest aborts adapter disposal when a destroy hook rejects. The error remains
			// available through shutdownError and the explicit close() promise.
		}
	}

	async #performClose(): Promise<void> {
		const errors: unknown[] = [];
		this.#unsubscribeCapabilityMutations?.();
		this.#unsubscribeCapabilityMutations = undefined;
		this.handlerRegistry.close();
		// Stop accepting inbound gateway work before closing its upstream clients.
		try {
			await this.servers.close();
		} catch (error) {
			errors.push(error);
		}
		const gatewayResults = await Promise.allSettled(
			[...this.#gateways.values()].map(async (gateway) => gateway.close()),
		);
		for (const result of gatewayResults) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		if (this.clientService !== undefined) {
			try {
				await this.clientService.closeFromAggregate();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#gateways.clear();
		this.#httpComposers.clear();
		this.#oauthProxies.clear();
		if (errors.length > 0) {
			this.#shutdownError = new AggregateError(errors, "One or more MCP runtimes failed to close.");
			throw this.#shutdownError;
		}
	}

	#assertReady(): void {
		if (!this.#ready) {
			throw new McpModuleError(
				"RUNTIME_NOT_READY",
				"The MCP runtime is not ready until Nest application bootstrap completes.",
			);
		}
	}

	#createGatewayFeature(serverName: string, options: McpNestGatewayOptions) {
		const {
			authorizationContextResolver: authorizationContextResolverToken,
			composition,
			discoveryCache: discoveryCacheToken,
			lifecycleObserver: lifecycleObserverToken,
			middleware: middlewareTokens,
			nameCodec: nameCodecToken,
			onObserverError: observerErrorReporterToken,
			policy: policyToken,
			promptNameCodec: promptNameCodecToken,
			resourceTemplateNameCodec: resourceTemplateNameCodecToken,
			resourceTemplateUriCodec: resourceTemplateUriCodecToken,
			resourceUriCodec: resourceUriCodecToken,
			upstreams: upstreamDefinitions,
			...gatewayOptions
		} = options;
		const policy = this.#bindGatewayPolicy(
			this.#resolveProvider<McpGatewayPolicy>(
				policyToken,
				serverName,
				"gateway policy",
				"authorize",
			),
			serverName,
		);
		const nameCodec = this.#resolveOptionalProvider(
			nameCodecToken,
			serverName,
			"gateway name codec",
			["encode", "decode", "tryDecode"],
		);
		const promptNameCodec = this.#resolveOptionalProvider(
			promptNameCodecToken,
			serverName,
			"gateway prompt name codec",
			["encode", "decode", "tryDecode"],
		);
		const resourceUriCodec = this.#resolveOptionalProvider(
			resourceUriCodecToken,
			serverName,
			"gateway resource URI codec",
			["encode", "decode", "tryDecode"],
		);
		const resourceTemplateUriCodec = this.#resolveOptionalProvider(
			resourceTemplateUriCodecToken,
			serverName,
			"gateway resource-template URI codec",
			["encode", "decode", "tryDecode"],
		);
		const resourceTemplateNameCodec = this.#resolveOptionalProvider(
			resourceTemplateNameCodecToken,
			serverName,
			"gateway resource-template name codec",
			["encode", "decode", "tryDecode"],
		);
		const discoveryCache = this.#resolveOptionalProvider(
			discoveryCacheToken,
			serverName,
			"gateway discovery cache",
			["get", "set", "delete", "clear"],
		);
		const authorizationContextProvider =
			authorizationContextResolverToken === undefined
				? undefined
				: this.#resolveProvider<McpGatewayAuthorizationContextProvider>(
						authorizationContextResolverToken,
						serverName,
						"gateway authorization context resolver",
						"resolveAuthorizationContext",
					);
		const middleware = this.#providerTokenList(
			middlewareTokens,
			serverName,
			"gateway middleware",
		).map((token) => {
			const provider = this.#resolveProvider<McpGatewayMiddlewareProvider>(
				token,
				serverName,
				"gateway middleware",
				"handle",
			);
			return bindMcpGatewayMiddleware(provider.handle, provider);
		});
		const lifecycleObserver =
			lifecycleObserverToken === undefined
				? undefined
				: this.#resolveProvider<McpGatewayLifecycleObserverProvider>(
						lifecycleObserverToken,
						serverName,
						"gateway lifecycle observer",
						"onEvent",
					);
		const observerErrorReporter =
			observerErrorReporterToken === undefined
				? undefined
				: this.#resolveProvider<McpGatewayObserverErrorReporter>(
						observerErrorReporterToken,
						serverName,
						"gateway observer error reporter",
						"report",
					);
		if (!Array.isArray(upstreamDefinitions)) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP gateway upstreams for server "${serverName}" must be an array.`,
			);
		}
		const upstreams = upstreamDefinitions.map((definition) => {
			if (isProviderGatewayUpstream(definition)) {
				if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
					throw new McpModuleError(
						"INVALID_OPTIONS",
						"Nest gateway provider-backed upstream names must be non-empty strings.",
					);
				}
				const clientProvider = this.#resolveProvider<McpGatewayClientProvider>(
					definition.clientProvider,
					serverName,
					`gateway client provider for upstream "${definition.name}"`,
					"resolveClient",
				);
				return Object.freeze({
					name: definition.name,
					client: clientProvider.resolveClient.bind(clientProvider),
				});
			}
			const normalized = normalizeGatewayUpstream(definition);
			if (!this.clients.has(normalized.clientName)) {
				throw new McpModuleError(
					"UNKNOWN_CLIENT",
					`Gateway upstream references unknown MCP client "${normalized.clientName}".`,
				);
			}
			return createMcpClientRuntimeUpstream(
				this.clients,
				normalized.clientName,
				normalized.gatewayName,
			);
		});
		const gateway = new McpGateway({
			...gatewayOptions,
			policy,
			upstreams,
			...(nameCodec === undefined ? {} : { nameCodec }),
			...(promptNameCodec === undefined ? {} : { promptNameCodec }),
			...(resourceUriCodec === undefined ? {} : { resourceUriCodec }),
			...(resourceTemplateUriCodec === undefined ? {} : { resourceTemplateUriCodec }),
			...(resourceTemplateNameCodec === undefined ? {} : { resourceTemplateNameCodec }),
			...(discoveryCache === undefined ? {} : { discoveryCache }),
			...(authorizationContextProvider === undefined
				? {}
				: {
						authorizationContextResolver:
							authorizationContextProvider.resolveAuthorizationContext.bind(
								authorizationContextProvider,
							),
					}),
			...(middleware.length === 0 ? {} : { middleware }),
			...(lifecycleObserver === undefined ? {} : { lifecycleObserver }),
			...(observerErrorReporter === undefined
				? {}
				: { onObserverError: observerErrorReporter.report.bind(observerErrorReporter) }),
		});
		this.#gateways.set(serverName, gateway);
		return gateway.asServerFeature({ toolsOnly: composition === "tools" });
	}

	#resolveOptionalProvider<Value>(
		token: McpProviderToken<Value> | undefined,
		serverName: string,
		role: string,
		methods: readonly string[],
	): Value | undefined {
		return token === undefined
			? undefined
			: this.#resolveProviderMethods(token, serverName, role, methods);
	}

	#resolveProvider<Value>(
		token: McpProviderToken<Value>,
		serverName: string,
		role: string,
		method: string,
	): Value {
		return this.#resolveProviderMethods(token, serverName, role, [method]);
	}

	#resolveProviderMethods<Value>(
		token: McpProviderToken<Value>,
		serverName: string,
		role: string,
		methods: readonly string[],
	): Value {
		try {
			const provider = this.providers.get(token);
			if (
				(typeof provider !== "object" && typeof provider !== "function") ||
				provider === null ||
				methods.some((method) => typeof Reflect.get(provider, method) !== "function")
			) {
				throw new TypeError(
					`resolved provider does not implement ${methods.map((method) => `${method}()`).join(", ")}`,
				);
			}
			// The configured contract for every collaborator is structural and method-based.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			return provider as Value;
		} catch (cause) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP ${role} ${mcpProviderTokenName(token)} for server "${serverName}" must be listed in McpModule collaborators.providers and implement ${methods.map((method) => `${method}()`).join(", ")}.`,
				{ cause },
			);
		}
	}

	#providerTokenList<Value>(
		value: readonly McpProviderToken<Value>[] | undefined,
		serverName: string,
		field: string,
	): readonly McpProviderToken<Value>[] {
		if (value === undefined) return [];
		if (Array.isArray(value)) return value;
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" ${field} must be an array of collaborator provider tokens.`,
		);
	}

	#bindGatewayPolicy(policy: McpGatewayPolicy, serverName: string): McpGatewayPolicy {
		const { authorizePrompt, authorizeResource, authorizeResourceTemplate } = policy;
		for (const [name, hook] of [
			["authorizePrompt", authorizePrompt],
			["authorizeResource", authorizeResource],
			["authorizeResourceTemplate", authorizeResourceTemplate],
		] as const) {
			if (hook !== undefined && typeof hook !== "function") {
				throw new McpModuleError(
					"INVALID_OPTIONS",
					`MCP gateway policy for server "${serverName}" has a non-callable ${name} hook.`,
				);
			}
		}
		return Object.freeze({
			authorize: (operation: Parameters<McpGatewayPolicy["authorize"]>[0]) =>
				policy.authorize(operation),
			...(authorizePrompt === undefined
				? {}
				: {
						authorizePrompt: (
							operation: Parameters<NonNullable<McpGatewayPolicy["authorizePrompt"]>>[0],
						) => authorizePrompt.call(policy, operation),
					}),
			...(authorizeResource === undefined
				? {}
				: {
						authorizeResource: (
							operation: Parameters<NonNullable<McpGatewayPolicy["authorizeResource"]>>[0],
						) => authorizeResource.call(policy, operation),
					}),
			...(authorizeResourceTemplate === undefined
				? {}
				: {
						authorizeResourceTemplate: (
							operation: Parameters<NonNullable<McpGatewayPolicy["authorizeResourceTemplate"]>>[0],
						) => authorizeResourceTemplate.call(policy, operation),
					}),
		});
	}
}

function isProviderGatewayUpstream(
	definition: McpNestGatewayUpstreamDefinition,
): definition is Extract<McpNestGatewayUpstreamDefinition, { readonly clientProvider: unknown }> {
	return typeof definition === "object" && definition !== null && "clientProvider" in definition;
}

function normalizeGatewayUpstream(definition: McpNestGatewayUpstreamDefinition): {
	readonly clientName: string;
	readonly gatewayName: string;
} {
	if (isProviderGatewayUpstream(definition)) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"A provider-backed gateway upstream cannot be normalized as a named client alias.",
		);
	}
	if (typeof definition !== "string" && (typeof definition !== "object" || definition === null)) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"Nest gateway upstreams must be named client aliases or provider-backed descriptors.",
		);
	}
	const clientName =
		typeof definition === "string"
			? definition
			: typeof definition.clientName === "string"
				? definition.clientName
				: "";
	const gatewayName =
		typeof definition === "string"
			? definition
			: definition.gatewayName === undefined
				? clientName
				: typeof definition.gatewayName === "string"
					? definition.gatewayName
					: "";
	if (clientName.trim().length === 0 || gatewayName.trim().length === 0) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"Nest gateway client and public namespace names must be non-empty strings.",
		);
	}
	return Object.freeze({ clientName, gatewayName });
}
