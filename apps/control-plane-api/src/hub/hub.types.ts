import type { McpGatewayUpstream } from "@nest-mcp/gateway";
import type { McpRuntimeCatalogSnapshot, McpRuntimePhase } from "@nest-mcp/manager";

import type { ManagedGatewayClient } from "./managed-gateway-client.ts";

export interface HubMemberView {
	readonly connectionId: string;
	readonly connectionRevision: number;
	readonly runtimeGeneration: number;
	readonly namespace: string;
	readonly displayName: string;
	readonly attachedAt: string;
	readonly runtime: { readonly phase: McpRuntimePhase };
}

export interface HubView {
	readonly revision: number;
	readonly updatedAt: string;
	readonly endpoint: {
		readonly transport: "streamable-http";
		readonly path: "/mcp/hub";
	};
	readonly members: readonly HubMemberView[];
	readonly counts: {
		readonly tools: number;
		readonly resources: number;
		readonly resourceTemplates: number;
		readonly prompts: number;
	};
}

export interface HubCatalogOrigin {
	readonly namespace: string;
	readonly sourceName: string;
}

export interface HubCatalogView {
	readonly revision: number;
	readonly publishedAt: string;
	readonly tools: readonly (HubCatalogOrigin & {
		readonly projectedName: string;
		readonly definition: Record<string, unknown>;
	})[];
	readonly resources: readonly (HubCatalogOrigin & {
		readonly projectedName: string;
		readonly projectedUri: string;
		readonly definition: Record<string, unknown>;
	})[];
	readonly resourceTemplates: readonly (HubCatalogOrigin & {
		readonly projectedName: string;
		readonly projectedUriTemplate: string;
		readonly definition: Record<string, unknown>;
	})[];
	readonly prompts: readonly (HubCatalogOrigin & {
		readonly projectedName: string;
		readonly definition: Record<string, unknown>;
	})[];
}

export interface HubMemberRecord {
	readonly connectionId: string;
	readonly runtimeGeneration: number;
	readonly generationKey: string;
	readonly namespace: string;
	readonly routeId: string;
	readonly attachedAt: string;
	readonly catalog: McpRuntimeCatalogSnapshot;
	readonly client: ManagedGatewayClient;
	readonly upstream: McpGatewayUpstream;
}
