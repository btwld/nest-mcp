import type { InjectionToken, ModuleMetadata, Provider } from "@nestjs/common";

/** Injection token for a Nest-owned MCP collaborator. */
export type McpProviderToken<Value> = InjectionToken<Value>;

/** Providers and dependency modules owned by an MCP dynamic module. */
export interface McpNestCollaborators {
	readonly imports?: ModuleMetadata["imports"];
	readonly providers?: readonly Provider[];
}
