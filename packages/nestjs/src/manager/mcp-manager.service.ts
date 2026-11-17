import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { McpRuntimeManager, type McpRuntimeManagerOptions } from "@nest-mcp/manager";

import { McpProviderRegistry, mcpProviderTokenName } from "../mcp-provider.registry.ts";
import type { McpProviderToken } from "../mcp-provider.types.ts";
import { MCP_MANAGER_MODULE_OPTIONS } from "../mcp.tokens.ts";
import { McpModuleError } from "../mcp.errors.ts";
import type {
	McpManagerClock,
	McpManagerModuleOptions,
	McpManagerStateListenerErrorReporter,
} from "./mcp-manager.types.ts";

/** Nest-owned dynamic MCP runtime manager with deterministic module shutdown. */
@Injectable()
export class McpManagerService extends McpRuntimeManager implements OnModuleDestroy {
	#shutdownError: AggregateError | undefined;

	constructor(
		@Inject(MCP_MANAGER_MODULE_OPTIONS) options: McpManagerModuleOptions,
		providers: McpProviderRegistry,
	) {
		super(resolveManagerOptions(options, providers));
	}

	/** Last cleanup failure contained by the Nest destroy hook, if any. */
	get shutdownError(): AggregateError | undefined {
		return this.#shutdownError;
	}

	async onModuleDestroy(): Promise<void> {
		try {
			await this.close();
		} catch (error) {
			this.#shutdownError =
				error instanceof AggregateError
					? error
					: new AggregateError([error], "The MCP runtime manager failed to close.");
		}
	}
}

function resolveManagerOptions(
	options: McpManagerModuleOptions,
	providers: McpProviderRegistry,
): McpRuntimeManagerOptions {
	const { clock, generationResolver, listenerErrorReporter, observer, ...data } = options;
	const resolvedGenerationResolver = requireMethodProvider(
		providers,
		generationResolver,
		"resolve",
	);
	const resolvedObserver =
		observer === undefined ? undefined : requireMethodProvider(providers, observer, "onEvent");
	const resolvedClock =
		clock === undefined
			? undefined
			: requireMethodProvider<McpManagerClock, "now">(providers, clock, "now");
	const resolvedListenerErrorReporter =
		listenerErrorReporter === undefined
			? undefined
			: requireMethodProvider<McpManagerStateListenerErrorReporter, "report">(
					providers,
					listenerErrorReporter,
					"report",
				);
	return {
		...data,
		generationResolver: resolvedGenerationResolver,
		...(resolvedObserver === undefined ? {} : { observer: resolvedObserver }),
		...(resolvedClock === undefined ? {} : { now: resolvedClock.now.bind(resolvedClock) }),
		...(resolvedListenerErrorReporter === undefined
			? {}
			: {
					onListenerError: resolvedListenerErrorReporter.report.bind(resolvedListenerErrorReporter),
				}),
	};
}

function requireMethodProvider<Value extends object, Method extends keyof Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
	method: Method,
): Value & Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>> {
	const provider = providers.get(token);
	if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP manager collaborator ${mcpProviderTokenName(token)} must be listed in McpManagerModule collaborators.providers.`,
		);
	}
	if (typeof Reflect.get(provider, method) !== "function") {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP manager collaborator ${mcpProviderTokenName(token)} must implement ${String(method)}().`,
		);
	}
	// Runtime validation above narrows the configured method to a callable.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider as Value &
		Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>>;
}
