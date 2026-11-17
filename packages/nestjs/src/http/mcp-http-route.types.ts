import type { ControllerOptions } from "@nestjs/common";

/** Public discovery routes backed by a server's configured oauth.resource metadata. */
export interface McpHttpDiscoveryRoutes {
	/** Include the path advertised by the resource server's bearer challenge; aliases are optional. */
	readonly protectedResourcePaths?: readonly string[];
	/** Explicit paths for the configured authorization-server metadata document. */
	readonly authorizationServerPaths?: readonly string[];
	/** Independent Nest class decorators; MCP route decorators are not copied to public discovery. */
	readonly decorators?: readonly ClassDecorator[];
}

/** Static Nest routing metadata, supplied outside useFactory when using forRootAsync. */
export interface McpHttpRoute {
	readonly serverName: string;
	/** A literal Nest path, with or without a leading slash. */
	readonly path: string;
	readonly version?: ControllerOptions["version"];
	/** Nest class decorators such as UseGuards, UseInterceptors, and application route metadata. */
	readonly decorators?: readonly ClassDecorator[];
	/** Optional discovery endpoints. Requires oauth.resource.metadata on the named runtime. */
	readonly discovery?: McpHttpDiscoveryRoutes;
}
