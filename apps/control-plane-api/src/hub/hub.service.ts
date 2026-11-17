import { randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { McpRuntimeService } from "@nest-mcp/nestjs";
import { McpGateway, McpGatewayError, allowAllMcpGatewayPolicy } from "@nest-mcp/gateway";
import type { McpRuntimeCatalogSnapshot, McpRuntimeManagerPort } from "@nest-mcp/manager";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ConnectionLifecycleCoordinator } from "../connections/connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "../connections/connection.repository.ts";
import type { ConnectionRecord } from "../connections/connection.types.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../runtime/runtime.types.ts";
import { CONTROL_PLANE_HUB_SERVER_NAME } from "./hub.tokens.ts";
import type { HubCatalogView, HubMemberRecord, HubView } from "./hub.types.ts";
import { ManagedGatewayClient } from "./managed-gateway-client.ts";

@Injectable()
export class HubService {
	readonly #membersByConnection = new Map<string, HubMemberRecord>();
	readonly #membersByNamespace = new Map<string, HubMemberRecord>();
	readonly #membersByRoute = new Map<string, HubMemberRecord>();
	#mutationTail: Promise<void> = Promise.resolve();
	#revision = 1;
	#updatedAt = new Date().toISOString();
	#publishedAt = this.#updatedAt;

	constructor(
		@Inject(ConnectionRepository) private readonly connections: ConnectionRepository,
		@Inject(ConnectionLifecycleCoordinator)
		private readonly connectionLifecycle: ConnectionLifecycleCoordinator,
		@Inject(MCP_RUNTIME_SUPERVISOR) private readonly manager: McpRuntimeManagerPort,
		@Inject(McpRuntimeService) private readonly mcpRuntime: McpRuntimeService,
	) {}

	view(): HubView {
		const members = [...this.#membersByConnection.values()]
			.toSorted((left, right) => left.namespace.localeCompare(right.namespace, "en-US"))
			.map((member) => {
				const connection = this.connections.get(member.connectionId);
				return Object.freeze({
					connectionId: connection.id,
					connectionRevision: connection.revision,
					runtimeGeneration: member.runtimeGeneration,
					namespace: member.namespace,
					displayName: connection.displayName,
					attachedAt: member.attachedAt,
					runtime: Object.freeze({ phase: this.manager.state(member.generationKey).phase }),
				});
			});
		return Object.freeze({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			endpoint: Object.freeze({
				transport: "streamable-http" as const,
				path: "/mcp/hub" as const,
			}),
			members: Object.freeze(members),
			counts: this.#counts(),
		});
	}

	attach(
		connectionId: string,
		input: {
			readonly namespace: string;
			readonly expectedHubRevision: number;
			readonly expectedConnectionRevision: number;
			readonly runtimeGeneration: number;
		},
	): Promise<HubView> {
		return this.connectionLifecycle.run(connectionId, () =>
			this.#serialize(async () => {
				this.#assertRevision(input.expectedHubRevision);
				const connection = this.#attachedConnection(
					connectionId,
					input.expectedConnectionRevision,
					input.runtimeGeneration,
				);
				const existing = this.#membersByConnection.get(connectionId);
				if (existing !== undefined) {
					if (
						existing.namespace === input.namespace &&
						existing.runtimeGeneration === input.runtimeGeneration
					) {
						return this.view();
					}
					throw new ControlPlaneError(
						"MCP_HUB_MEMBER_CONFLICT",
						409,
						"The MCP connection is already attached to the hub.",
					);
				}
				if (this.#membersByNamespace.has(input.namespace)) {
					throw new ControlPlaneError(
						"MCP_HUB_NAMESPACE_CONFLICT",
						409,
						"The MCP hub namespace is already attached.",
					);
				}

				const state = await this.manager.ensureOnline(connection.generationKey);
				if (state.phase !== "online") throw notReadyError();
				const catalog = hubCatalog(await this.manager.refreshCatalog(connection.generationKey));
				const member = this.#member(connection, input.namespace, catalog);
				await this.#preflight([...this.#membersByConnection.values(), member]);

				const gateway = this.#gateway();
				try {
					await gateway.attachUpstream(member.upstream, {
						expectedRevision: gateway.topology().revision,
					});
				} catch (error) {
					throw mapGatewayError(error);
				}
				this.#membersByConnection.set(connectionId, member);
				this.#membersByNamespace.set(member.namespace, member);
				this.#membersByRoute.set(member.routeId, member);
				this.#commit();
				this.#notifyChanged();
				return this.view();
			}),
		);
	}

	detach(
		connectionId: string,
		expectedHubRevision: number,
		runtimeGeneration: number,
	): Promise<void> {
		return this.connectionLifecycle.run(connectionId, () =>
			this.#serialize(async () => {
				this.#assertRevision(expectedHubRevision);
				const member = this.#requireMember(connectionId);
				if (member.runtimeGeneration !== runtimeGeneration) {
					throw new ControlPlaneError(
						"MCP_GENERATION_RETIRED",
						409,
						"The attached MCP runtime generation is no longer current.",
					);
				}
				await this.#detachMember(member);
			}),
		);
	}

	/** Called by connection lifecycle code while its per-connection lock is already held. */
	detachConnection(connectionId: string): Promise<void> {
		return this.#serialize(async () => {
			const member = this.#membersByConnection.get(connectionId);
			if (member !== undefined) await this.#detachMember(member);
		});
	}

	catalog(expectedHubRevision?: number): Promise<HubCatalogView> {
		return this.#serialize(() => {
			if (expectedHubRevision !== undefined) this.#assertRevision(expectedHubRevision);
			return this.#catalog();
		});
	}

	async #catalog(): Promise<HubCatalogView> {
		const gateway = this.#gateway();
		const [tools, resources, resourceTemplates, prompts] = await Promise.all([
			gateway.listProjectedTools(),
			gateway.listProjectedResources(),
			gateway.listProjectedResourceTemplates(),
			gateway.listProjectedPrompts(),
		]);
		const namespace = (routeId: string): string => this.#requireRoute(routeId).namespace;
		return Object.freeze({
			revision: this.#revision,
			publishedAt: this.#publishedAt,
			tools: Object.freeze(
				tools
					.map((item) =>
						Object.freeze({
							namespace: namespace(item.upstreamName),
							sourceName: item.toolName,
							projectedName: item.projectedName,
							definition: item.definition,
						}),
					)
					.toSorted((left, right) =>
						left.projectedName.localeCompare(right.projectedName, "en-US"),
					),
			),
			resources: Object.freeze(
				resources
					.map((item) =>
						Object.freeze({
							namespace: namespace(item.upstreamName),
							sourceName: item.resourceName,
							projectedName: item.projectedName,
							projectedUri: item.projectedUri,
							definition: item.definition,
						}),
					)
					.toSorted((left, right) => left.projectedUri.localeCompare(right.projectedUri, "en-US")),
			),
			resourceTemplates: Object.freeze(
				resourceTemplates
					.map((item) =>
						Object.freeze({
							namespace: namespace(item.upstreamName),
							sourceName: item.resourceTemplateName,
							projectedName: item.projectedName,
							projectedUriTemplate: item.projectedTemplateUri,
							definition: item.definition,
						}),
					)
					.toSorted((left, right) =>
						left.projectedUriTemplate.localeCompare(right.projectedUriTemplate, "en-US"),
					),
			),
			prompts: Object.freeze(
				prompts
					.map((item) =>
						Object.freeze({
							namespace: namespace(item.upstreamName),
							sourceName: item.promptName,
							projectedName: item.projectedName,
							definition: item.definition,
						}),
					)
					.toSorted((left, right) =>
						left.projectedName.localeCompare(right.projectedName, "en-US"),
					),
			),
		});
	}

	refresh(expectedHubRevision: number): Promise<HubView> {
		return this.#serialize(async () => {
			this.#assertRevision(expectedHubRevision);
			const currentMembers = [...this.#membersByConnection.values()];
			const prepared = await Promise.all(
				currentMembers.map(async (member) => {
					const connection = this.connections.get(member.connectionId);
					if (
						connection.runtimeGeneration !== member.runtimeGeneration ||
						connection.desiredState !== "online" ||
						connection.deletionPending
					) {
						throw new ControlPlaneError(
							"MCP_GENERATION_RETIRED",
							409,
							"An attached MCP generation is no longer authoritative.",
						);
					}
					const catalog = hubCatalog(await this.manager.refreshCatalog(member.generationKey));
					return Object.freeze({
						member,
						catalog,
						candidate: this.#memberWithCatalog(member, catalog),
					});
				}),
			);
			await this.#preflight(prepared.map((entry) => entry.candidate));
			for (const entry of prepared) entry.member.client.updateCatalog(entry.catalog);
			await this.#gateway().invalidateAllDiscovery();
			for (const entry of prepared) {
				const refreshed = Object.freeze({ ...entry.member, catalog: entry.catalog });
				this.#membersByConnection.set(refreshed.connectionId, refreshed);
				this.#membersByNamespace.set(refreshed.namespace, refreshed);
				this.#membersByRoute.set(refreshed.routeId, refreshed);
			}
			this.#commit();
			this.#notifyChanged();
			return this.view();
		});
	}

	#member(
		connection: ConnectionRecord,
		namespace: string,
		catalog: McpRuntimeCatalogSnapshot,
	): HubMemberRecord {
		const routeId = `r-${randomBytes(16).toString("base64url")}`;
		const client = new ManagedGatewayClient(connection.generationKey, catalog, this.manager);
		return Object.freeze({
			connectionId: connection.id,
			runtimeGeneration: connection.runtimeGeneration,
			generationKey: connection.generationKey,
			namespace,
			routeId,
			attachedAt: new Date().toISOString(),
			catalog,
			client,
			upstream: Object.freeze({ name: routeId, client }),
		});
	}

	#memberWithCatalog(member: HubMemberRecord, catalog: McpRuntimeCatalogSnapshot): HubMemberRecord {
		const client = new ManagedGatewayClient(member.generationKey, catalog, this.manager);
		return Object.freeze({
			...member,
			catalog,
			client,
			upstream: Object.freeze({ name: member.routeId, client }),
		});
	}

	async #preflight(members: readonly HubMemberRecord[]): Promise<void> {
		const candidate = new McpGateway({
			upstreams: members.map((member) => member.upstream),
			policy: allowAllMcpGatewayPolicy(),
		});
		try {
			await Promise.all([
				candidate.listProjectedTools(),
				candidate.listProjectedResources(),
				candidate.listProjectedResourceTemplates(),
				candidate.listProjectedPrompts(),
			]);
		} catch (error) {
			throw mapGatewayError(error);
		} finally {
			await candidate.close().catch(() => undefined);
		}
	}

	async #detachMember(member: HubMemberRecord): Promise<void> {
		const gateway = this.#gateway();
		try {
			await gateway.detachUpstream(member.routeId, {
				expectedRevision: gateway.topology().revision,
			});
		} catch (error) {
			throw mapGatewayError(error);
		}
		this.#membersByConnection.delete(member.connectionId);
		this.#membersByNamespace.delete(member.namespace);
		this.#membersByRoute.delete(member.routeId);
		this.#commit();
		this.#notifyChanged();
	}

	#attachedConnection(
		connectionId: string,
		expectedConnectionRevision: number,
		runtimeGeneration: number,
	): ConnectionRecord {
		const connection = this.connections.get(connectionId);
		if (connection.revision !== expectedConnectionRevision) {
			throw new ControlPlaneError(
				"MCP_REVISION_CONFLICT",
				409,
				"The MCP connection changed after it was read.",
			);
		}
		if (connection.runtimeGeneration !== runtimeGeneration) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The requested MCP runtime generation has been retired.",
			);
		}
		if (connection.desiredState !== "online" || connection.deletionPending) throw notReadyError();
		return connection;
	}

	#requireMember(connectionId: string): HubMemberRecord {
		const member = this.#membersByConnection.get(connectionId);
		if (member !== undefined) return member;
		throw new ControlPlaneError(
			"MCP_HUB_MEMBER_NOT_FOUND",
			404,
			"The MCP connection is not attached to the hub.",
		);
	}

	#requireRoute(routeId: string): HubMemberRecord {
		const member = this.#membersByRoute.get(routeId);
		if (member !== undefined) return member;
		throw new ControlPlaneError(
			"MCP_HUB_MEMBER_NOT_FOUND",
			404,
			"The projected MCP hub route is no longer attached.",
		);
	}

	#assertRevision(expectedRevision: number): void {
		if (expectedRevision === this.#revision) return;
		throw new ControlPlaneError(
			"MCP_HUB_REVISION_CONFLICT",
			409,
			"The MCP hub changed after it was read.",
		);
	}

	#gateway(): McpGateway {
		return this.mcpRuntime.gateway(CONTROL_PLANE_HUB_SERVER_NAME);
	}

	#counts() {
		let tools = 0;
		let resources = 0;
		let resourceTemplates = 0;
		let prompts = 0;
		for (const member of this.#membersByConnection.values()) {
			tools += member.catalog.tools.length;
			resources += member.catalog.resources.length;
			resourceTemplates += member.catalog.resourceTemplates.length;
			prompts += member.catalog.prompts.length;
		}
		return Object.freeze({ tools, resources, resourceTemplates, prompts });
	}

	#commit(): void {
		this.#revision += 1;
		this.#updatedAt = new Date().toISOString();
		this.#publishedAt = this.#updatedAt;
	}

	#notifyChanged(): void {
		const notifier = this.mcpRuntime.server(CONTROL_PLANE_HUB_SERVER_NAME).notify;
		try {
			notifier.toolsChanged();
		} catch {
			// A committed topology remains authoritative if a listener races shutdown.
		}
		try {
			notifier.resourcesChanged();
		} catch {
			// A committed topology remains authoritative if a listener races shutdown.
		}
		try {
			notifier.promptsChanged();
		} catch {
			// A committed topology remains authoritative if a listener races shutdown.
		}
	}

	async #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
		const predecessor = this.#mutationTail;
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#mutationTail = current;
		await predecessor;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}
}

function hubCatalog(catalog: McpRuntimeCatalogSnapshot): McpRuntimeCatalogSnapshot {
	return Object.freeze({
		...catalog,
		tools: Object.freeze(
			catalog.tools.filter((tool) => tool.execution?.taskSupport !== "required"),
		),
		resources: Object.freeze([...catalog.resources]),
		resourceTemplates: Object.freeze([...catalog.resourceTemplates]),
		prompts: Object.freeze([...catalog.prompts]),
	});
}

function notReadyError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_NOT_READY",
		409,
		"The MCP connection must be online before it can join the hub.",
	);
}

function mapGatewayError(error: unknown): unknown {
	if (!(error instanceof McpGatewayError)) return error;
	switch (error.code) {
		case "TOPOLOGY_REVISION_CONFLICT":
			return new ControlPlaneError(
				"MCP_HUB_REVISION_CONFLICT",
				409,
				"The MCP hub changed after it was read.",
				{ cause: error },
			);
		case "DUPLICATE_UPSTREAM":
			return new ControlPlaneError(
				"MCP_HUB_NAMESPACE_CONFLICT",
				409,
				"The MCP hub namespace is already attached.",
				{ cause: error },
			);
		case "UNKNOWN_UPSTREAM":
			return new ControlPlaneError(
				"MCP_HUB_MEMBER_NOT_FOUND",
				404,
				"The MCP hub member is no longer attached.",
				{ cause: error },
			);
		case "GATEWAY_CLOSED":
			return new ControlPlaneError("MCP_HUB_CLOSED", 503, "The process-local MCP hub is closed.", {
				cause: error,
			});
		default:
			return new ControlPlaneError(
				"MCP_HUB_CATALOG_INVALID",
				422,
				"The upstream MCP catalog cannot be projected into the hub.",
				{ cause: error },
			);
	}
}
