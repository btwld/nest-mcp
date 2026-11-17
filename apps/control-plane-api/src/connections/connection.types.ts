import type { Prompt, Resource, ResourceTemplateType, Tool } from "@modelcontextprotocol/client";

export type DesiredConnectionState = "offline" | "online";
export type ConnectionAuthenticationKind = "none" | "oauth";

export interface ConnectionRecord {
	readonly id: string;
	readonly revision: number;
	readonly runtimeGeneration: number;
	readonly generationKey: string;
	readonly displayName: string;
	readonly authenticationKind: ConnectionAuthenticationKind;
	readonly desiredState: DesiredConnectionState;
	readonly deletionPending: boolean;
	readonly endpoint: string;
	readonly endpointHost: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CreateConnectionInput {
	readonly displayName: string;
	readonly authenticationKind: ConnectionAuthenticationKind;
	readonly desiredState: DesiredConnectionState;
	readonly endpoint: string;
	readonly endpointHost: string;
}

export interface ReplaceConnectionInput {
	readonly displayName: string;
	readonly endpoint: string;
	readonly endpointHost: string;
}

export interface ConnectionReplacement {
	readonly previous: ConnectionRecord;
	readonly current: ConnectionRecord;
	readonly generationChanged: boolean;
}

export interface CatalogSnapshot {
	readonly connectionId: string;
	readonly runtimeGeneration: number;
	readonly discoveredAt: string;
	readonly tools: readonly Tool[];
	readonly resources: readonly Resource[];
	readonly resourceTemplates: readonly ResourceTemplateType[];
	readonly prompts: readonly Prompt[];
}

export function connectionGenerationKey(connectionId: string, runtimeGeneration: number): string {
	return `control-plane-mcp/v1/${connectionId}/${String(runtimeGeneration)}`;
}
