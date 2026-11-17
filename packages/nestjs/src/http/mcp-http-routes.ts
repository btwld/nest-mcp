import {
	All,
	Controller,
	Inject,
	Req,
	Res,
	VERSION_NEUTRAL,
	applyDecorators,
	type DynamicModule,
	type Type,
} from "@nestjs/common";
import {
	buildOAuthProtectedResourceMetadata,
	getOAuthProtectedResourceMetadataUrl,
	oauthMetadataResponse,
	type AuthMetadataOptions,
} from "@nest-mcp/server/auth";
import { McpHttpControllerFor } from "../mcp-http.controller.ts";
import { McpRuntimeService } from "../mcp-runtime.service.ts";
import { McpModuleError } from "../mcp.errors.ts";
import { MCP_MODULE_OPTIONS } from "../mcp.tokens.ts";
import type { McpModuleOptions, McpNestServerDefinition } from "../mcp.types.ts";
import type { McpHttpRoute } from "./mcp-http-route.types.ts";
import { toWebRequestWithBody, writeWebResponse } from "./node-bridge.ts";

/** Generates ordinary Nest controllers while retaining the existing protocol/security pipeline. */
export function withMcpHttpRoutes(
	definition: DynamicModule,
	routes: readonly McpHttpRoute[] | undefined,
): DynamicModule {
	if (routes === undefined) return definition;
	if (!Array.isArray(routes)) throw invalid("httpRoutes must be an array.");
	const paths = new Set<string>();
	const controllers: Type<unknown>[] = [];
	for (const input of routes) {
		if (!input || typeof input.serverName !== "string" || input.serverName.trim().length === 0) {
			throw invalid("Every httpRoutes entry requires a non-empty serverName.");
		}
		if (
			input.discovery !== undefined &&
			(!input.discovery || typeof input.discovery !== "object")
		) {
			throw invalid("HTTP discovery must be an object.");
		}
		const route: McpHttpRoute = {
			serverName: input.serverName,
			path: claimPath(input.path, paths),
			...(input.version === undefined
				? {}
				: { version: Array.isArray(input.version) ? [...input.version] : input.version }),
			decorators: decorators(input.decorators),
			...(input.discovery === undefined
				? {}
				: {
						discovery: {
							protectedResourcePaths: claimPaths(input.discovery.protectedResourcePaths, paths),
							authorizationServerPaths: claimPaths(input.discovery.authorizationServerPaths, paths),
							decorators: decorators(input.discovery.decorators),
						},
					}),
		};
		if (
			route.discovery !== undefined &&
			!route.discovery.protectedResourcePaths?.length &&
			!route.discovery.authorizationServerPaths?.length
		) {
			throw invalid("HTTP discovery requires at least one document path.");
		}
		controllers.push(httpController(route));
		for (const kind of ["protectedResource", "authorizationServer"] as const) {
			const documentPaths = route.discovery?.[`${kind}Paths`];
			if (documentPaths?.length) controllers.push(discoveryController(route, kind, documentPaths));
		}
	}
	return { ...definition, controllers: [...(definition.controllers ?? []), ...controllers] };
}

function httpController(route: McpHttpRoute) {
	const Base = McpHttpControllerFor(route.serverName);
	@Controller({
		path: route.path,
		...(route.version === undefined ? {} : { version: route.version }),
	})
	class GeneratedMcpHttpController extends Base {
		constructor(
			@Inject(McpRuntimeService) runtime: McpRuntimeService,
			@Inject(MCP_MODULE_OPTIONS) options: McpModuleOptions,
		) {
			super(runtime);
			const server = requireServer(options, route.serverName);
			if (route.discovery !== undefined) discoveryMetadata(server, route);
		}
	}
	applyDecorators(...(route.decorators ?? []))(GeneratedMcpHttpController);
	return GeneratedMcpHttpController;
}

function discoveryController(
	route: McpHttpRoute,
	kind: "protectedResource" | "authorizationServer",
	paths: readonly string[],
) {
	@Controller({ version: VERSION_NEUTRAL })
	class GeneratedMcpDiscoveryController {
		readonly #metadata: AuthMetadataOptions;
		constructor(@Inject(MCP_MODULE_OPTIONS) options: McpModuleOptions) {
			this.#metadata = discoveryMetadata(requireServer(options, route.serverName), route);
		}

		@All([...paths])
		async document(
			@Req() request: unknown,
			@Res({ passthrough: true }) response: unknown,
		): Promise<void> {
			const incoming = toWebRequestWithBody(request, undefined);
			// Nest selected the route. Project aliases onto the SDK's canonical metadata paths.
			const url =
				kind === "protectedResource"
					? getOAuthProtectedResourceMetadataUrl(this.#metadata.resourceServerUrl)
					: new URL("/.well-known/oauth-authorization-server", this.#metadata.resourceServerUrl)
							.href;
			const result = oauthMetadataResponse(
				new Request(url, { method: incoming.method, headers: incoming.headers }),
				this.#metadata,
			);
			if (result === undefined) throw invalid("The SDK did not resolve the discovery document.");
			await writeWebResponse(result, response);
		}
	}
	applyDecorators(...(route.discovery?.decorators ?? []))(GeneratedMcpDiscoveryController);
	return GeneratedMcpDiscoveryController;
}

function requireServer(options: McpModuleOptions, name: string): McpNestServerDefinition {
	const server = options.servers?.find((candidate) => candidate.name === name);
	if (server === undefined) throw invalid(`HTTP route references unknown MCP server "${name}".`);
	return server;
}

function discoveryMetadata(
	server: McpNestServerDefinition,
	route: McpHttpRoute,
): AuthMetadataOptions {
	const resource = server.oauth?.resource;
	const metadata = resource?.metadata;
	if (resource === undefined || metadata === undefined) {
		throw invalid(`HTTP discovery for "${server.name}" requires oauth.resource.metadata.`);
	}
	const options: AuthMetadataOptions = {
		resourceServerUrl: new URL(resource.resourceServerUrl),
		oauthMetadata: structuredClone(metadata.oauthMetadata),
		...(metadata.resourceName === undefined ? {} : { resourceName: metadata.resourceName }),
		...(metadata.scopesSupported === undefined
			? {}
			: { scopesSupported: [...metadata.scopesSupported] }),
		...(metadata.serviceDocumentationUrl === undefined
			? {}
			: {
					serviceDocumentationUrl: new URL(metadata.serviceDocumentationUrl),
				}),
	};
	buildOAuthProtectedResourceMetadata(options);
	const expectedPath = new URL(
		getOAuthProtectedResourceMetadataUrl(options.resourceServerUrl),
	).pathname.slice(1);
	const resourcePaths = route.discovery?.protectedResourcePaths;
	if (resourcePaths?.length && !resourcePaths.includes(expectedPath)) {
		throw invalid(
			`HTTP discovery for "${server.name}" must include its bearer challenge path "${expectedPath}".`,
		);
	}
	return options;
}

function claimPaths(input: readonly string[] | undefined, paths: Set<string>): readonly string[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length === 0)
		throw invalid("Discovery document paths must be non-empty arrays.");
	return input.map((path) => claimPath(path, paths));
}

function claimPath(input: string, paths: Set<string>): string {
	if (
		typeof input !== "string" ||
		!/^\/?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(input)
	) {
		throw invalid(
			"HTTP route paths must be literal paths without queries, fragments, or router patterns.",
		);
	}
	const path = input.replace(/^\//u, "").replace(/\/$/u, "");
	if (path.split("/").some((segment) => segment === "." || segment === ".."))
		throw invalid("HTTP route paths cannot contain dot segments.");
	// Express is case-insensitive by default; reject collisions consistently on both adapters.
	const key = path.toLowerCase();
	if (paths.has(key)) throw invalid(`Duplicate MCP HTTP route path "${path}".`);
	paths.add(key);
	return path;
}

function decorators(input: readonly ClassDecorator[] | undefined): readonly ClassDecorator[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.some((decorator) => typeof decorator !== "function"))
		throw invalid("HTTP route decorators must be class decorator functions.");
	return [...input];
}

function invalid(message: string): McpModuleError {
	return new McpModuleError("INVALID_OPTIONS", message);
}
