import { McpClientModule, McpClientService, McpModuleError } from "@nest-mcp/nestjs/client";
import type {
	McpClientForRootAsyncOptions,
	McpClientForRootOptions,
	McpClientModuleOptions,
	McpNestCollaborators,
	McpProviderToken,
} from "@nest-mcp/nestjs/client";

type AssertFalse<Value extends false> = Value;
type PublicClientApi = typeof import("@nest-mcp/nestjs/client");

/** Proves inbound-only values stay out of the outbound client entrypoint. */
export type InboundRuntimeValuesAreAbsent = [
	AssertFalse<"McpModule" extends keyof PublicClientApi ? true : false>,
	AssertFalse<"McpRuntimeService" extends keyof PublicClientApi ? true : false>,
	AssertFalse<"McpOAuthService" extends keyof PublicClientApi ? true : false>,
];

/** Proves the standalone entrypoint carries its complete module/provider type surface. */
export type ClientModulePublicTypes = {
	readonly sync: McpClientForRootOptions;
	readonly async: McpClientForRootAsyncOptions;
	readonly options: McpClientModuleOptions;
	readonly collaborators: McpNestCollaborators;
	readonly token: McpProviderToken<unknown>;
};

void McpClientModule;
void McpClientService;
void McpModuleError;
