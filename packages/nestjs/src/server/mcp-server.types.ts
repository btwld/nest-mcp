import type {
	CreateMcpHandlerOptions,
	ServerContext,
	ServerEventBus,
	ServerOptions,
	jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import type { MaybePromise } from "@nest-mcp/core";
import type { McpProviderToken } from "../mcp-provider.types.ts";

export interface McpRequestStateVerifier {
	verify(state: string, context: ServerContext): MaybePromise<unknown>;
}

export interface McpNestServerOptions extends Omit<
	ServerOptions,
	"jsonSchemaValidator" | "requestState"
> {
	readonly jsonSchemaValidator?: McpProviderToken<jsonSchemaValidator>;
	readonly requestState?: Omit<NonNullable<ServerOptions["requestState"]>, "verify"> & {
		readonly verifier?: McpProviderToken<McpRequestStateVerifier>;
	};
}

export interface McpNestServerHttpOptions extends Omit<CreateMcpHandlerOptions, "bus" | "onerror"> {
	/** Injectable long-lived event bus used by modern change subscriptions. */
	readonly eventBus?: McpProviderToken<ServerEventBus>;
}
