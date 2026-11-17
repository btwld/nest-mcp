import type { McpLifecycleObserver } from "@nest-mcp/core";
import type {
	McpRuntimeGenerationResolver,
	McpRuntimeManagerOptions,
	McpRuntimeStateTransitionEvent,
} from "@nest-mcp/manager";

import type { McpNestCollaborators, McpProviderToken } from "../mcp-provider.types.ts";

export interface McpManagerClock {
	now(): number;
}

export interface McpManagerStateListenerErrorReporter {
	report(error: unknown, event: McpRuntimeStateTransitionEvent): void | PromiseLike<void>;
}

export interface McpManagerModuleOptions extends Omit<
	McpRuntimeManagerOptions,
	"generationResolver" | "now" | "observer" | "onListenerError"
> {
	readonly generationResolver: McpProviderToken<McpRuntimeGenerationResolver>;
	readonly observer?: McpProviderToken<McpLifecycleObserver>;
	readonly clock?: McpProviderToken<McpManagerClock>;
	readonly listenerErrorReporter?: McpProviderToken<McpManagerStateListenerErrorReporter>;
}

export interface McpManagerModuleExtras {
	/** Make the manager service globally injectable. Defaults to false. */
	readonly isGlobal?: boolean;
	/** Singleton providers referenced by the manager module's provider-token options. */
	readonly collaborators?: McpNestCollaborators;
}
