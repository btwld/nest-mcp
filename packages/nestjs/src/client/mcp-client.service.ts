import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnModuleDestroy,
} from "@nestjs/common";
import { McpClientRuntime } from "@nest-mcp/client";
import { McpProviderRegistry } from "../mcp-provider.registry.ts";
import { MCP_CLIENT_MODULE_OPTIONS } from "../mcp.tokens.ts";
import type { McpClientModuleOptions } from "./mcp-client.types.ts";
import { resolveMcpClientRuntimeOptions } from "./mcp-client.runtime-options.ts";

/** Nest-owned MCP client runtime with application bootstrap and shutdown lifecycle. */
@Injectable()
export class McpClientService
	extends McpClientRuntime
	implements OnApplicationBootstrap, OnModuleDestroy
{
	#bootstrapTask: Promise<void> | undefined;
	#shutdownError: AggregateError | undefined;
	#aggregateOwnsShutdown = false;

	constructor(
		@Inject(MCP_CLIENT_MODULE_OPTIONS) private readonly moduleOptions: McpClientModuleOptions,
		providers: McpProviderRegistry,
	) {
		super(resolveMcpClientRuntimeOptions(moduleOptions, providers));
	}

	/** Last cleanup failure contained by the Nest destroy hook, if any. */
	get shutdownError(): AggregateError | undefined {
		return this.#shutdownError;
	}

	onApplicationBootstrap(): Promise<void> {
		if (this.#bootstrapTask !== undefined) return this.#bootstrapTask;
		this.#bootstrapTask = this.#performBootstrap();
		return this.#bootstrapTask;
	}

	/** @internal Coordinates aggregate server -> gateway -> client shutdown exactly once. */
	closeFromAggregate(): Promise<void> {
		this.#aggregateOwnsShutdown = true;
		return this.close();
	}

	async onModuleDestroy(): Promise<void> {
		if (this.#aggregateOwnsShutdown) return;
		try {
			await this.close();
		} catch (error) {
			this.#shutdownError =
				error instanceof AggregateError
					? error
					: new AggregateError([error], "The MCP client runtime failed to close.");
		}
	}

	async #performBootstrap(): Promise<void> {
		if (this.moduleOptions.bootstrap?.connectAll !== true) return;
		try {
			await this.connectAll();
		} catch (bootstrapError) {
			try {
				await this.close();
			} catch (cleanupError) {
				// Both caught failures are retained explicitly in AggregateError.errors.
				// oxlint-disable-next-line eslint/preserve-caught-error
				throw new AggregateError(
					[bootstrapError, cleanupError],
					"MCP client bootstrap failed and its runtime could not close cleanly.",
					{ cause: bootstrapError },
				);
			}
			throw bootstrapError;
		}
	}
}
