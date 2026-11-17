import type { InjectionToken } from "@nestjs/common";
import type { MaybePromise } from "@nest-mcp/core";
import type { McpServerBuildContext } from "@nest-mcp/server";

/** Decides whether capabilities are installed on one freshly built request server. */
export interface McpCapabilityVisibilityPolicy {
	isVisible(context: Readonly<McpServerBuildContext>): MaybePromise<boolean>;
}

/** Static visibility or a singleton Nest provider evaluated once per server build. */
export type McpCapabilityVisibility = boolean | InjectionToken<McpCapabilityVisibilityPolicy>;

/** A live dynamic registration backed by the registry's copy-on-write snapshot. */
export interface McpDynamicHandlerRegistration<Handler> {
	readonly source: string;
	/** Atomically replaces only the callback while preserving capability metadata. */
	replace(handler: Handler): boolean;
	/** Atomically removes this exact registration. */
	unregister(): boolean;
}

export type McpCapabilityMutationKind = "tool" | "resource" | "prompt";
export type McpCapabilityMutationType = "registered" | "replaced" | "unregistered";

/** Internal/publicly observable mutation description; contains no handler payload. */
export interface McpCapabilityMutation {
	readonly kind: McpCapabilityMutationKind;
	readonly type: McpCapabilityMutationType;
	readonly source: string;
	readonly serverNames: readonly string[];
}

export type McpCapabilityMutationObserver = (mutation: McpCapabilityMutation) => MaybePromise<void>;

/** Public, callback-free description of one registered capability. */
export interface McpCapabilityDescriptor {
	readonly kind: McpCapabilityMutationKind;
	readonly name: string;
	readonly source: string;
	readonly serverNames: readonly string[];
}
