import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/client";
import {
	createMcpClientToolSchema,
	type CallToolResult,
	type GetPromptResult,
	type ReadResourceResult,
} from "@nest-mcp/client";
import { captureMcpToolArguments, type McpConformanceCaptureLimits } from "@nest-mcp/conformance";
import type {
	McpRuntimeManagerPort,
	McpRuntimeManagerSnapshot,
	McpRuntimeProbeSnapshot,
	McpRuntimeStateSnapshot,
} from "@nest-mcp/manager";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { HubService } from "../hub/hub.service.ts";
import type { OAuthConnectionView } from "../oauth/oauth.types.ts";
import { VolatileOAuthAuthorityService } from "../oauth/volatile-oauth-authority.service.ts";
import { McpEndpointAdmissionService } from "../runtime/mcp-endpoint-admission.service.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../runtime/runtime.types.ts";
import type {
	CatalogSnapshot,
	ConnectionRecord,
	DesiredConnectionState,
} from "./connection.types.ts";
import { ConnectionLifecycleCoordinator } from "./connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "./connection.repository.ts";

/** Control-plane ceiling for one untrusted tool-call argument payload. */
const TOOL_ARGUMENTS_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: 262_144,
	maxDepth: 24,
	maxProperties: 4_096,
	maxStringBytes: 65_536,
	maxItems: 1_024,
});

export interface ConnectionView {
	readonly id: string;
	readonly revision: number;
	readonly runtimeGeneration: number;
	readonly displayName: string;
	readonly desiredState: DesiredConnectionState;
	readonly deletionPending: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly transport: {
		readonly kind: "http";
		readonly host: string;
	};
	readonly authentication:
		| {
				readonly kind: "none";
				readonly configured: true;
		  }
		| OAuthConnectionView;
	readonly runtime: McpRuntimeStateSnapshot;
}

@Injectable()
export class ConnectionControlService {
	constructor(
		@Inject(ConnectionRepository) private readonly connections: ConnectionRepository,
		@Inject(ConnectionLifecycleCoordinator)
		private readonly lifecycle: ConnectionLifecycleCoordinator,
		@Inject(McpEndpointAdmissionService) private readonly admission: McpEndpointAdmissionService,
		@Inject(MCP_RUNTIME_SUPERVISOR)
		private readonly runtime: McpRuntimeManagerPort,
		@Inject(HubService) private readonly hub: HubService,
		@Inject(VolatileOAuthAuthorityService)
		private readonly oauth: VolatileOAuthAuthorityService,
	) {}

	async create(input: {
		readonly displayName: string;
		readonly endpoint: string;
		readonly desiredState: DesiredConnectionState;
		readonly authenticationKind?: "none" | "oauth";
	}): Promise<ConnectionView> {
		const endpoint = this.admission.admit(input.endpoint);
		const record = this.connections.create({
			displayName: input.displayName,
			desiredState: input.authenticationKind === "oauth" ? "offline" : input.desiredState,
			endpoint: endpoint.url,
			endpointHost: endpoint.host,
			authenticationKind: input.authenticationKind ?? "none",
		});
		if (record.authenticationKind === "oauth") this.oauth.registerConnection(record.id);
		return this.#serialize(record.id, async () => {
			if (record.desiredState === "online") await this.#attemptOnline(record);
			return this.#view(record);
		});
	}

	list(): readonly ConnectionView[] {
		return Object.freeze(this.connections.list().map((record) => this.#view(record)));
	}

	get(connectionId: string): ConnectionView {
		return this.#view(this.connections.get(connectionId));
	}

	async replace(
		connectionId: string,
		expectedRevision: number,
		input: { readonly displayName: string; readonly endpoint?: string },
	): Promise<ConnectionView> {
		return this.#serialize(connectionId, async () => {
			const previous = this.connections.get(connectionId);
			assertConnectionMutation(previous, expectedRevision);
			const endpoint =
				input.endpoint === undefined
					? Object.freeze({ url: previous.endpoint, host: previous.endpointHost })
					: this.admission.admit(input.endpoint);
			if (endpoint.url !== previous.endpoint) await this.hub.detachConnection(connectionId);
			const replacement = this.connections.replace(connectionId, expectedRevision, {
				displayName: input.displayName,
				endpoint: endpoint.url,
				endpointHost: endpoint.host,
			});
			if (replacement.generationChanged) {
				this.connections.forgetGeneration(replacement.previous.generationKey);
				try {
					await this.runtime.retire(replacement.previous.generationKey);
				} catch {
					// The aggregate runtime snapshot exposes the quarantined capacity charge.
				}
				if (replacement.current.authenticationKind === "oauth") {
					this.oauth.resetConnection(connectionId, replacement.previous.generationKey);
				}
			}
			if (replacement.current.desiredState === "online") {
				await this.#attemptOnline(replacement.current);
			}
			return this.#view(replacement.current);
		});
	}

	async setDesiredState(
		connectionId: string,
		expectedRevision: number,
		desiredState: DesiredConnectionState,
	): Promise<ConnectionView> {
		return this.#serialize(connectionId, async () => {
			const previous = this.connections.get(connectionId);
			assertConnectionMutation(previous, expectedRevision);
			if (desiredState === "offline") await this.hub.detachConnection(connectionId);
			const record = this.connections.setDesiredState(connectionId, expectedRevision, desiredState);
			if (desiredState === "online") await this.#attemptOnline(record);
			else await this.runtime.setOffline(record.generationKey);
			return this.#view(record);
		});
	}

	remove(connectionId: string, expectedRevision: number): Promise<void> {
		return this.#serialize(connectionId, async () => {
			const previous = this.connections.get(connectionId);
			assertConnectionMutation(previous, expectedRevision);
			await this.hub.detachConnection(connectionId);
			const tombstone = this.connections.beginRemoval(connectionId, expectedRevision);
			try {
				await this.runtime.retire(tombstone.generationKey);
			} finally {
				if (tombstone.authenticationKind === "oauth") {
					this.oauth.removeConnection(connectionId, tombstone.generationKey);
				}
			}
			this.connections.commitRemoval(connectionId, tombstone.revision);
		});
	}

	probe(connectionId: string): Promise<McpRuntimeProbeSnapshot> {
		const record = this.connections.get(connectionId);
		this.#requireAuthorized(record);
		return this.runtime.probe(record.generationKey);
	}

	getCatalog(connectionId: string): CatalogSnapshot {
		const catalog = this.connections.getCatalog(connectionId);
		if (catalog === undefined) {
			throw new ControlPlaneError(
				"MCP_NOT_READY",
				409,
				"The MCP connection does not have a discovered catalog.",
			);
		}
		return catalog;
	}

	async refreshCatalog(connectionId: string): Promise<CatalogSnapshot> {
		const record = this.connections.get(connectionId);
		this.#requireAuthorized(record);
		const catalog = await this.runtime.refreshCatalog(record.generationKey);
		return this.connections.putCatalog(
			Object.freeze({
				connectionId: record.id,
				runtimeGeneration: record.runtimeGeneration,
				...catalog,
			}),
		);
	}

	async callTool(
		connectionId: string,
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
	): Promise<CallToolResult> {
		const record = this.#onlineConnection(connectionId);
		const catalog = this.getCatalog(connectionId);
		if (catalog.runtimeGeneration !== record.runtimeGeneration) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The discovered MCP catalog belongs to a retired runtime generation.",
			);
		}
		const discoveredTool = catalog.tools.find((tool) => tool.name === name);
		if (discoveredTool === undefined) {
			throw new ControlPlaneError(
				"MCP_TOOL_NOT_FOUND",
				404,
				"The MCP tool does not exist in the current discovered catalog.",
			);
		}

		const toolDefinition = snapshotToolDefinition(discoveredTool);
		const stableArguments = snapshotToolArguments(arguments_);
		await validateToolArguments(toolDefinition, stableArguments);

		return this.runtime.callTool(record.generationKey, toolDefinition.name, stableArguments, {
			toolDefinition,
		});
	}

	readResource(connectionId: string, uri: string): Promise<ReadResourceResult> {
		const record = this.#onlineConnection(connectionId);
		return this.runtime.readResource(record.generationKey, uri);
	}

	getPrompt(
		connectionId: string,
		name: string,
		arguments_: Readonly<Record<string, string>> | undefined,
	): Promise<GetPromptResult> {
		const record = this.#onlineConnection(connectionId);
		return this.runtime.getPrompt(record.generationKey, name, arguments_);
	}

	runtimeSnapshot(): McpRuntimeManagerSnapshot {
		return this.runtime.snapshot();
	}

	#onlineConnection(connectionId: string): ConnectionRecord {
		const record = this.connections.get(connectionId);
		if (record.desiredState !== "online") {
			throw new ControlPlaneError(
				"MCP_NOT_READY",
				409,
				"The MCP connection must be online before it can execute operations.",
			);
		}
		this.#requireAuthorized(record);
		return record;
	}

	#requireAuthorized(record: ConnectionRecord): void {
		if (record.authenticationKind !== "oauth" || this.oauth.isAuthorized(record.generationKey)) {
			return;
		}
		throw new ControlPlaneError(
			"MCP_OAUTH_AUTHORIZATION_REQUIRED",
			409,
			"The MCP connection requires OAuth authorization.",
		);
	}

	async #attemptOnline(record: ConnectionRecord): Promise<void> {
		if (record.authenticationKind === "oauth" && !this.oauth.isAuthorized(record.generationKey)) {
			return;
		}
		try {
			await this.runtime.ensureOnline(record.generationKey);
		} catch {
			// Desired state remains authoritative; the safe runtime projection reports failure.
		}
	}

	async #serialize<Result>(
		connectionId: string,
		operation: () => Promise<Result>,
	): Promise<Result> {
		return this.lifecycle.run(connectionId, operation);
	}

	#view(record: ConnectionRecord): ConnectionView {
		return Object.freeze({
			id: record.id,
			revision: record.revision,
			runtimeGeneration: record.runtimeGeneration,
			displayName: record.displayName,
			desiredState: record.desiredState,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			deletionPending: record.deletionPending,
			transport: Object.freeze({ kind: "http" as const, host: record.endpointHost }),
			authentication:
				record.authenticationKind === "none"
					? Object.freeze({ kind: "none" as const, configured: true as const })
					: this.oauth.view(record.id, record.generationKey),
			runtime: this.runtime.state(record.generationKey),
		});
	}
}

function snapshotToolDefinition(tool: Tool): Tool {
	try {
		return Object.freeze(structuredClone(tool));
	} catch (cause) {
		throw invalidToolSchemaError(cause);
	}
}

function snapshotToolArguments(
	arguments_: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	try {
		return captureMcpToolArguments(arguments_, TOOL_ARGUMENTS_CAPTURE_LIMITS);
	} catch (cause) {
		throw new ControlPlaneError(
			"MCP_TOOL_ARGUMENTS_INVALID",
			422,
			"The MCP tool arguments must be bounded JSON-compatible data.",
			{ cause },
		);
	}
}

async function validateToolArguments(
	tool: Tool,
	arguments_: Readonly<Record<string, unknown>>,
): Promise<void> {
	let validation: Awaited<
		ReturnType<ReturnType<typeof createMcpClientToolSchema>["~standard"]["validate"]>
	>;
	try {
		const schema = createMcpClientToolSchema(tool.inputSchema);
		validation = await schema["~standard"].validate(arguments_);
	} catch (cause) {
		throw invalidToolSchemaError(cause);
	}
	const issues = "issues" in validation ? validation.issues : undefined;
	if (issues === undefined || issues.length === 0) return;
	throw new ControlPlaneError(
		"MCP_TOOL_ARGUMENTS_INVALID",
		422,
		"The MCP tool arguments do not match the discovered input schema.",
	);
}

function invalidToolSchemaError(cause: unknown): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_TOOL_SCHEMA_INVALID",
		502,
		"The MCP tool declares an input schema that cannot be compiled.",
		{ cause },
	);
}

function assertConnectionMutation(record: ConnectionRecord, expectedRevision: number): void {
	if (record.revision !== expectedRevision) {
		throw new ControlPlaneError(
			"MCP_REVISION_CONFLICT",
			409,
			"The MCP connection changed after it was read.",
		);
	}
	if (record.deletionPending) {
		throw new ControlPlaneError(
			"MCP_CONNECTION_DELETING",
			409,
			"The MCP connection is fenced for deletion.",
		);
	}
}
