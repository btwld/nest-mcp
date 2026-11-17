import { captureMcpConformanceValue } from "./capture.ts";
import { digestMcpRuntimeCatalog, type McpConformanceCatalogSnapshot } from "./catalog.ts";
import { assertMcpConformanceDomain } from "./fingerprint.ts";
import { defineMcpConformancePlan } from "./plan.ts";
import { MCP_CONFORMANCE_HARD_CAPTURE_LIMITS, type McpConformanceCaptureLimits } from "./limits.ts";
import type { McpConformanceCheckOutcome, McpConformancePlan } from "./types.ts";

/** A host-acquired inspection surface. This package never opens or owns a transport. */
export interface McpPassiveDiscoveryTarget {
	snapshot(): {
		readonly state: string;
		readonly negotiatedProtocolVersion?: string;
		readonly protocolEra?: string;
	};
	ping(signal: AbortSignal): Promise<void>;
	catalog(signal: AbortSignal): Promise<McpConformanceCatalogSnapshot>;
	schemaCompiles(schema: unknown): boolean;
}

export interface McpPassiveDiscoveryPlanOptions {
	readonly id?: string;
	readonly version?: string;
	readonly title?: string;
	readonly catalogDomain: string;
	readonly toolSchemaDomain: string;
}

const MAX_INSPECTED_SCHEMAS = 256;

const TOOL_SCHEMA_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: 256 * 1_024,
	maxDepth: 64,
	maxItems: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
	maxProperties: 10_000,
	maxStringBytes: 256 * 1_024,
});

const CATALOG_DIGEST_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxBytes,
	maxDepth: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxDepth,
	maxItems: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
	maxProperties: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxProperties,
	maxStringBytes: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxStringBytes,
});

/** Seven bounded, read-only checks; no tool invocation, caller-authored checks, or durable run state. */
export function createMcpPassiveDiscoveryPlan(
	options: McpPassiveDiscoveryPlanOptions,
): McpConformancePlan<McpPassiveDiscoveryTarget> {
	const { catalogDomain, toolSchemaDomain } = options;
	assertMcpConformanceDomain(catalogDomain, "catalogDomain");
	assertMcpConformanceDomain(toolSchemaDomain, "toolSchemaDomain");
	return defineMcpConformancePlan({
		id: options.id ?? "mcp-safe-discovery",
		version: options.version ?? "1.0.0",
		title: options.title ?? "Safe MCP discovery conformance",
		checks: [
			{
				id: "connection.connected",
				title: "Managed connection is connected",
				risk: "read-only",
				run: ({ target }) => {
					const snapshot = target.snapshot();
					return snapshot.state === "connected"
						? outcome("pass", "CONNECTION_CONNECTED", {
								state: snapshot.state,
							})
						: outcome("fail", "CONNECTION_NOT_CONNECTED", {
								state: snapshot.state,
							});
				},
			},
			{
				id: "protocol.negotiated",
				title: "Protocol version is negotiated",
				risk: "read-only",
				run: ({ target }) => {
					const snapshot = target.snapshot();
					if (
						snapshot.negotiatedProtocolVersion === undefined ||
						snapshot.protocolEra === undefined
					) {
						return outcome("fail", "PROTOCOL_NOT_NEGOTIATED");
					}
					return outcome("pass", "PROTOCOL_NEGOTIATED", {
						protocolEra: snapshot.protocolEra,
						protocolVersion: snapshot.negotiatedProtocolVersion,
					});
				},
			},
			{
				id: "protocol.ping",
				title: "Server answers a ping",
				risk: "read-only",
				async run({ target, signal }) {
					try {
						await target.ping(signal);
						return outcome("pass", "PING_SUCCEEDED");
					} catch {
						signal.throwIfAborted();
						return outcome("error", "PING_UNAVAILABLE");
					}
				},
			},
			{
				id: "catalog.discovery",
				title: "Bounded catalog discovery succeeds",
				risk: "read-only",
				timeoutMs: 6_000,
				async run({ target, signal }) {
					try {
						const catalog = await target.catalog(signal);
						return outcome("pass", "CATALOG_DISCOVERED", catalogCounts(catalog));
					} catch {
						signal.throwIfAborted();
						return outcome("error", "CATALOG_DISCOVERY_ERROR");
					}
				},
			},
			{
				id: "catalog.identities",
				title: "Catalog identities are unique",
				risk: "read-only",
				async run({ target, signal }) {
					try {
						const duplicateCount = countDuplicates(await target.catalog(signal));
						return duplicateCount === 0
							? outcome("pass", "CATALOG_IDENTITIES_UNIQUE")
							: outcome("fail", "CATALOG_IDENTITIES_DUPLICATED", {
									duplicateCount,
								});
					} catch {
						signal.throwIfAborted();
						return outcome("error", "CATALOG_UNAVAILABLE");
					}
				},
			},
			{
				id: "tools.schemas",
				title: "Tool schemas compile",
				risk: "read-only",
				async run({ target, signal }) {
					try {
						const catalog = await target.catalog(signal);
						let invalidInputSchemas = 0;
						let invalidOutputSchemas = 0;
						const budget = { schemaCount: 0 };
						try {
							for (const tool of catalog.tools) {
								if (!toolSchemaCompiles(tool.inputSchema, budget, target)) {
									invalidInputSchemas += 1;
								}
								if (
									tool.outputSchema !== undefined &&
									!toolSchemaCompiles(tool.outputSchema, budget, target)
								) {
									invalidOutputSchemas += 1;
								}
							}
						} catch (error: unknown) {
							if (error instanceof ToolSchemaBudgetExceededError) {
								return outcome("error", "TOOL_SCHEMA_BUDGET_EXCEEDED", {
									inspectedSchemaCount: budget.schemaCount,
								});
							}
							throw error;
						}
						const invalidSchemas = invalidInputSchemas + invalidOutputSchemas;
						return invalidSchemas === 0
							? outcome("pass", "TOOL_SCHEMAS_COMPILE", {
									toolCount: catalog.tools.length,
								})
							: outcome("fail", "TOOL_SCHEMAS_INVALID", {
									invalidInputSchemas,
									invalidOutputSchemas,
								});
					} catch {
						signal.throwIfAborted();
						return outcome("error", "CATALOG_UNAVAILABLE");
					}
				},
			},
			{
				id: "catalog.digest",
				title: "Catalog has a stable semantic digest",
				risk: "read-only",
				async run({ target, signal }) {
					try {
						const catalog = await target.catalog(signal);
						const digest = digestMcpRuntimeCatalog(catalog, {
							domain: catalogDomain,
							limits: CATALOG_DIGEST_CAPTURE_LIMITS,
							toolSchemaDomain,
						});
						return outcome("pass", "CATALOG_DIGESTED", {
							catalogDigest: digest.catalogFingerprint,
						});
					} catch {
						signal.throwIfAborted();
						return outcome("error", "CATALOG_DIGEST_ERROR");
					}
				},
			},
		],
	});
}

function outcome(
	status: McpConformanceCheckOutcome["status"],
	code: string,
	facts?: McpConformanceCheckOutcome["facts"],
): McpConformanceCheckOutcome {
	return Object.freeze({
		code,
		...(facts === undefined ? {} : { facts }),
		status,
	});
}

function catalogCounts(catalog: McpConformanceCatalogSnapshot): Record<string, number> {
	return {
		promptCount: catalog.prompts.length,
		resourceCount: catalog.resources.length,
		resourceTemplateCount: catalog.resourceTemplates.length,
		toolCount: catalog.tools.length,
	};
}

function countDuplicates(catalog: McpConformanceCatalogSnapshot): number {
	return (
		duplicates(catalog.tools.map(({ name }) => name)) +
		duplicates(catalog.resources.map(({ uri }) => uri)) +
		duplicates(catalog.resourceTemplates.map(({ uriTemplate }) => uriTemplate)) +
		duplicates(catalog.prompts.map(({ name }) => name))
	);
}

function duplicates(identities: readonly string[]): number {
	return identities.length - new Set(identities).size;
}

interface ToolSchemaBudget {
	schemaCount: number;
}

class ToolSchemaBudgetExceededError extends Error {}

function toolSchemaCompiles(
	schema: unknown,
	budget: ToolSchemaBudget,
	target: McpPassiveDiscoveryTarget,
): boolean {
	budget.schemaCount += 1;
	if (budget.schemaCount > MAX_INSPECTED_SCHEMAS) {
		throw new ToolSchemaBudgetExceededError("The MCP tool schema budget was exceeded.");
	}
	try {
		const captured = captureMcpConformanceValue(schema, TOOL_SCHEMA_CAPTURE_LIMITS);
		return target.schemaCompiles(captured);
	} catch {
		return false;
	}
}
