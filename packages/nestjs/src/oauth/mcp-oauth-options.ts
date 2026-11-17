import {
	createMcpClientIdMetadataResolver,
	McpOAuthProxy,
	McpOAuthSecretKeyring,
	McpOAuthServer,
	McpUpstreamAdapter,
} from "@nest-mcp/auth";
import type {
	McpClientIdMetadataResolver,
	McpOAuthClientResolver,
	McpOAuthProxyOptions,
	McpUpstreamSubjectResolver,
} from "@nest-mcp/auth";
import type { McpFetchHandler, McpResourceServerOptions } from "@nest-mcp/server/auth";
import { McpResourceServer } from "@nest-mcp/server/auth";
import { McpModuleError } from "../mcp.errors.ts";
import type { McpProviderRegistry } from "../mcp-provider.registry.ts";
import { requireMethodProvider } from "../server/provider-resolution.ts";
import type { McpNestServerOAuthOptions } from "./mcp-oauth.types.ts";

export interface McpResolvedServerOAuth {
	/** Composes the configured OAuth protection around a runtime's fetch handler. */
	readonly compose: (handler: McpFetchHandler) => McpFetchHandler;
	/** The authorization-server proxy, when `oauth.proxy` is configured. */
	readonly proxy?: McpOAuthProxy;
}

/**
 * Resolves the `oauth` group into a composition function (and, for the proxy,
 * the `McpOAuthProxy` instance). Returns `undefined` when nothing is configured.
 */
export function resolveMcpNestServerOAuth(
	options: McpNestServerOAuthOptions | undefined,
	providers: McpProviderRegistry,
	serverName: string,
): McpResolvedServerOAuth | undefined {
	if (options === undefined) return undefined;
	if (options.proxy !== undefined && options.resource !== undefined) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" configures both oauth.proxy and oauth.resource; the proxy already protects the resource. Configure exactly one.`,
		);
	}
	if (options.proxy !== undefined) {
		return resolveProxy(options, providers, serverName);
	}
	if (options.resource !== undefined) {
		const compose = resolveResource(options, providers, serverName);
		return compose === undefined ? undefined : { compose };
	}
	return undefined;
}

function resolveProxy(
	options: McpNestServerOAuthOptions,
	providers: McpProviderRegistry,
	serverName: string,
): McpResolvedServerOAuth {
	const proxyOptions = options.proxy;
	if (proxyOptions === undefined) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" is missing oauth.proxy.`,
		);
	}
	if (typeof proxyOptions.issuer !== "string" || proxyOptions.issuer.length === 0) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" oauth.proxy.issuer must be a non-empty string.`,
		);
	}
	const primaryResource = proxyOptions.resources?.[0];
	if (
		!Array.isArray(proxyOptions.resources) ||
		proxyOptions.resources.length === 0 ||
		typeof primaryResource !== "string"
	) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" oauth.proxy.resources must list at least one resource URL.`,
		);
	}

	const signingKeys = requireMethodProvider(
		providers,
		proxyOptions.signingKeys,
		"getSigningKeys",
	).getSigningKeys();
	const masterSecret = requireMethodProvider(
		providers,
		proxyOptions.secret,
		"getMasterSecret",
	).getMasterSecret();
	const upstreamConfig = requireMethodProvider(
		providers,
		proxyOptions.upstream,
		"getUpstream",
	).getUpstream();
	const stateStore = requireMethodProvider(providers, proxyOptions.stateStore, "take");
	const tokenStore =
		proxyOptions.tokenStore === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.tokenStore, "take");
	const clientResolver: McpOAuthClientResolver | undefined =
		proxyOptions.clientResolver === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.clientResolver, "resolveClient");
	const consentRenderer =
		proxyOptions.consent === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.consent, "render").render;
	const subjectResolver: McpUpstreamSubjectResolver | undefined =
		proxyOptions.subjectResolver === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.subjectResolver, "resolveSubject")
					.resolveSubject;
	const anonymousProvider =
		proxyOptions.anonymous === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.anonymous, "permit");
	const guardedFetch =
		proxyOptions.fetch === undefined
			? undefined
			: requireMethodProvider(providers, proxyOptions.fetch, "fetch").fetch;

	const cimd: McpClientIdMetadataResolver | undefined =
		proxyOptions.cimd?.enabled === true
			? createMcpClientIdMetadataResolver({
					...(proxyOptions.cimd.allowedHosts === undefined
						? {}
						: { allowedHosts: proxyOptions.cimd.allowedHosts }),
					...(proxyOptions.cimd.maxDocumentBytes === undefined
						? {}
						: { maxDocumentBytes: proxyOptions.cimd.maxDocumentBytes }),
					...(proxyOptions.cimd.fetchTimeoutMs === undefined
						? {}
						: { fetchTimeoutMs: proxyOptions.cimd.fetchTimeoutMs }),
				})
			: undefined;

	const upstream = new McpUpstreamAdapter({
		upstream: upstreamConfig,
		...(guardedFetch === undefined ? {} : { fetch: guardedFetch }),
	});
	const proxyConstructorOptions: McpOAuthProxyOptions = {
		issuer: proxyOptions.issuer,
		resources: proxyOptions.resources,
		signingKeys,
		secrets: new McpOAuthSecretKeyring(masterSecret),
		upstream,
		stateStore,
		...(proxyOptions.basePath === undefined ? {} : { basePath: proxyOptions.basePath }),
		...(proxyOptions.scopesSupported === undefined
			? {}
			: { scopesSupported: proxyOptions.scopesSupported }),
		...(tokenStore === undefined ? {} : { tokenStore }),
		...(cimd === undefined ? {} : { cimd }),
		...(clientResolver === undefined ? {} : { clientResolver }),
		...(consentRenderer === undefined ? {} : { consentRenderer }),
		...(subjectResolver === undefined ? {} : { resolveUpstreamSubject: subjectResolver }),
		...(proxyOptions.ttl === undefined ? {} : { ttl: proxyOptions.ttl }),
	};
	const proxy = new McpOAuthProxy(proxyConstructorOptions);

	// Advertise the exact (non-suffixed) protected-resource metadata URL the OAuth
	// controller serves at origin root, so the 401 challenge resolves.
	const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", proxyOptions.issuer)
		.href;
	const resourceServerOptions: McpResourceServerOptions = {
		bearerAuth: {
			verifier: proxy.verifier,
			resourceMetadataUrl,
			...(proxyOptions.requiredScopes === undefined
				? {}
				: { requiredScopes: [...proxyOptions.requiredScopes] }),
		},
		metadata: {
			oauthMetadata: proxy.authorizationServerMetadata,
			resourceServerUrl: new URL(primaryResource),
		},
		...(anonymousProvider === undefined
			? {}
			: { anonymous: async (request: Request) => anonymousProvider.permit(request) }),
	};

	const compose = (handler: McpFetchHandler): McpFetchHandler =>
		new McpOAuthServer(new McpResourceServer(handler, resourceServerOptions), {
			proxy,
			...(proxyOptions.basePath === undefined ? {} : { basePath: proxyOptions.basePath }),
		});

	return { compose, proxy };
}

function resolveResource(
	options: McpNestServerOAuthOptions,
	providers: McpProviderRegistry,
	serverName: string,
): ((handler: McpFetchHandler) => McpFetchHandler) | undefined {
	const resource = options.resource;
	if (resource === undefined) return undefined;

	if (typeof resource.resourceServerUrl !== "string" || resource.resourceServerUrl.length === 0) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" oauth.resource.resourceServerUrl must be a non-empty URL string.`,
		);
	}
	let resourceServerUrl: URL;
	try {
		resourceServerUrl = new URL(resource.resourceServerUrl);
	} catch {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server "${serverName}" oauth.resource.resourceServerUrl must be a valid URL.`,
		);
	}

	const verifier = requireMethodProvider(providers, resource.verifier, "verifyAccessToken");
	const anonymousProvider =
		resource.anonymous === undefined
			? undefined
			: requireMethodProvider(providers, resource.anonymous, "permit");

	const resourceServerOptions: McpResourceServerOptions = {
		bearerAuth: {
			verifier,
			...(resource.requiredScopes === undefined
				? {}
				: { requiredScopes: [...resource.requiredScopes] }),
		},
		...(resource.metadata === undefined
			? {}
			: {
					metadata: {
						oauthMetadata: resource.metadata.oauthMetadata,
						resourceServerUrl,
						...(resource.metadata.serviceDocumentationUrl === undefined
							? {}
							: { serviceDocumentationUrl: new URL(resource.metadata.serviceDocumentationUrl) }),
						...(resource.metadata.scopesSupported === undefined
							? {}
							: { scopesSupported: [...resource.metadata.scopesSupported] }),
						...(resource.metadata.resourceName === undefined
							? {}
							: { resourceName: resource.metadata.resourceName }),
					},
				}),
		...(anonymousProvider === undefined
			? {}
			: { anonymous: async (request: Request) => anonymousProvider.permit(request) }),
	};

	return (handler) => new McpResourceServer(handler, resourceServerOptions);
}
