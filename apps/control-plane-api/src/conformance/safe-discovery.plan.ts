import {
	METHOD_NOT_FOUND,
	ProtocolError,
	type Prompt,
	type Resource,
	type ResourceTemplateType,
	type Tool,
} from "@modelcontextprotocol/client";
import {
	createMcpClientToolSchema,
	type McpClientToolInputSchema,
	type McpClientToolOutputSchema,
} from "@nest-mcp/client";
import {
	captureMcpConformanceValue,
	defineMcpConformancePlan,
	digestMcpRuntimeCatalog,
	MCP_CONFORMANCE_HARD_CAPTURE_LIMITS,
	type McpConformanceCaptureLimits,
	type McpConformanceCheckOutcome,
	type McpConformancePlan,
} from "@nest-mcp/conformance";
import type { McpManagedClientRuntime } from "@nest-mcp/manager";

import { SAFE_DISCOVERY_PLAN_ID } from "./conformance.types.ts";

/** Fingerprint domains that name what this control plane digests. */
const CATALOG_DIGEST_DOMAIN = "mcp-catalog";
const TOOL_SCHEMA_DIGEST_DOMAIN = "mcp-tool-schema";

/** How many schemas one run may compile; capture limits bound each one's size. */
const MAX_INSPECTED_SCHEMAS = 256;

/**
 * Capture bounds for untrusted upstream payloads. `@nest-mcp/conformance`
 * owns the walking and the refusal; this plan only picks the numbers, clamped
 * to that package's hard ceilings wherever its limit is the tighter one.
 */
const TOOL_SCHEMA_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: 262_144,
	maxDepth: 64,
	maxProperties: 10_000,
	maxStringBytes: 262_144,
	maxItems: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
});

const CATALOG_ITEM_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: 2_097_152,
	maxDepth: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxDepth,
	maxProperties: 20_000,
	maxStringBytes: 1_048_576,
	maxItems: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
});

const CATALOG_DIGEST_CAPTURE_LIMITS: McpConformanceCaptureLimits = Object.freeze({
	maxBytes: 4_194_304,
	maxDepth: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxDepth,
	maxProperties: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxProperties,
	maxStringBytes: 1_048_576,
	maxItems: MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
});

export interface SafeDiscoveryCatalog {
	readonly tools: readonly Tool[];
	readonly resources: readonly Resource[];
	readonly resourceTemplates: readonly ResourceTemplateType[];
	readonly prompts: readonly Prompt[];
}

export interface SafeDiscoveryTarget {
	snapshot(): ReturnType<McpManagedClientRuntime["snapshot"]>;
	ping(signal: AbortSignal): Promise<void>;
	catalog(signal: AbortSignal): Promise<SafeDiscoveryCatalog>;
}

export const SAFE_DISCOVERY_PLAN: McpConformancePlan<SafeDiscoveryTarget> =
	defineMcpConformancePlan({
		id: SAFE_DISCOVERY_PLAN_ID,
		version: "1.0.0",
		title: "Safe MCP discovery conformance",
		checks: [
			{
				id: "connection.connected",
				title: "Managed connection is connected",
				risk: "read-only",
				run: ({ target }) => {
					const snapshot = target.snapshot();
					return snapshot.state === "connected"
						? outcome("pass", "CONNECTION_CONNECTED", { state: snapshot.state })
						: outcome("fail", "CONNECTION_NOT_CONNECTED", { state: snapshot.state });
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
						protocolVersion: snapshot.negotiatedProtocolVersion,
						protocolEra: snapshot.protocolEra,
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
						const catalog = await target.catalog(signal);
						const duplicateCount = countDuplicates(catalog);
						return duplicateCount === 0
							? outcome("pass", "CATALOG_IDENTITIES_UNIQUE")
							: outcome("fail", "CATALOG_IDENTITIES_DUPLICATED", { duplicateCount });
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
						const budget = createToolSchemaBudget();
						try {
							for (const tool of catalog.tools) {
								if (!toolSchemaCompiles(tool.inputSchema, budget)) {
									invalidInputSchemas += 1;
								}
								if (
									tool.outputSchema !== undefined &&
									!toolSchemaCompiles(tool.outputSchema, budget)
								) {
									invalidOutputSchemas += 1;
								}
							}
						} catch (error) {
							if (error instanceof ToolSchemaBudgetExceededError) {
								return outcome("error", "TOOL_SCHEMA_BUDGET_EXCEEDED", {
									inspectedSchemaCount: budget.schemaCount,
								});
							}
							throw error;
						}
						const invalidSchemas = invalidInputSchemas + invalidOutputSchemas;
						return invalidSchemas === 0
							? outcome("pass", "TOOL_SCHEMAS_COMPILE", { toolCount: catalog.tools.length })
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
						return outcome("pass", "CATALOG_DIGESTED", {
							catalogDigest: digestMcpRuntimeCatalog(catalog, {
								domain: CATALOG_DIGEST_DOMAIN,
								toolSchemaDomain: TOOL_SCHEMA_DIGEST_DOMAIN,
								limits: CATALOG_DIGEST_CAPTURE_LIMITS,
							}).catalogFingerprint,
						});
					} catch {
						signal.throwIfAborted();
						return outcome("error", "CATALOG_DIGEST_ERROR");
					}
				},
			},
		],
	});

export function createSafeDiscoveryTarget(input: {
	readonly runtime: McpManagedClientRuntime;
	readonly serverName: string;
	readonly leaseSignal: AbortSignal;
	readonly maxPages: number;
	readonly maxItems: number;
}): SafeDiscoveryTarget {
	let catalogTask: Promise<SafeDiscoveryCatalog> | undefined;
	return Object.freeze({
		snapshot: () => input.runtime.snapshot(input.serverName),
		async ping(signal: AbortSignal): Promise<void> {
			await input.runtime.request(
				input.serverName,
				{ method: "ping" },
				{ signal: AbortSignal.any([input.leaseSignal, signal]) },
			);
		},
		catalog(signal: AbortSignal): Promise<SafeDiscoveryCatalog> {
			catalogTask ??= discoverCatalog(input, signal);
			return catalogTask;
		},
	});
}

async function discoverCatalog(
	input: Parameters<typeof createSafeDiscoveryTarget>[0],
	signal: AbortSignal,
): Promise<SafeDiscoveryCatalog> {
	const operationSignal = AbortSignal.any([input.leaseSignal, signal]);
	const snapshot = input.runtime.snapshot(input.serverName);
	const capabilities = snapshot.serverCapabilities;
	let totalItems = 0;
	const account = <Value>(items: readonly Value[]): readonly Value[] => {
		totalItems += items.length;
		if (totalItems > input.maxItems) throw new RangeError("catalog item limit exceeded");
		for (const item of items) captureMcpConformanceValue(item, CATALOG_ITEM_CAPTURE_LIMITS);
		return items;
	};

	const tools =
		capabilities?.tools === undefined
			? []
			: await aggregatePages<Tool>(
					async (cursor) => {
						const page = await input.runtime.request(
							input.serverName,
							cursor === undefined
								? { method: "tools/list", params: {} }
								: { method: "tools/list", params: { cursor } },
							{ signal: operationSignal },
						);
						return page.nextCursor === undefined
							? { items: account(page.tools) }
							: { items: account(page.tools), nextCursor: page.nextCursor };
					},
					input.maxPages,
					operationSignal,
				);
	const resources =
		capabilities?.resources === undefined
			? []
			: await aggregatePages<Resource>(
					async (cursor) => {
						const page = await input.runtime.request(
							input.serverName,
							cursor === undefined
								? { method: "resources/list", params: {} }
								: { method: "resources/list", params: { cursor } },
							{ signal: operationSignal },
						);
						return page.nextCursor === undefined
							? { items: account(page.resources) }
							: { items: account(page.resources), nextCursor: page.nextCursor };
					},
					input.maxPages,
					operationSignal,
				);
	let resourceTemplates: readonly ResourceTemplateType[] = [];
	if (capabilities?.resources !== undefined) {
		try {
			resourceTemplates = await aggregatePages<ResourceTemplateType>(
				async (cursor) => {
					const page = await input.runtime.request(
						input.serverName,
						cursor === undefined
							? { method: "resources/templates/list", params: {} }
							: { method: "resources/templates/list", params: { cursor } },
						{ signal: operationSignal },
					);
					return page.nextCursor === undefined
						? { items: account(page.resourceTemplates) }
						: { items: account(page.resourceTemplates), nextCursor: page.nextCursor };
				},
				input.maxPages,
				operationSignal,
			);
		} catch (error) {
			if (!(ProtocolError.isInstance(error) && error.code === METHOD_NOT_FOUND)) throw error;
		}
	}
	const prompts =
		capabilities?.prompts === undefined
			? []
			: await aggregatePages<Prompt>(
					async (cursor) => {
						const page = await input.runtime.request(
							input.serverName,
							cursor === undefined
								? { method: "prompts/list", params: {} }
								: { method: "prompts/list", params: { cursor } },
							{ signal: operationSignal },
						);
						return page.nextCursor === undefined
							? { items: account(page.prompts) }
							: { items: account(page.prompts), nextCursor: page.nextCursor };
					},
					input.maxPages,
					operationSignal,
				);

	return Object.freeze({
		tools: Object.freeze(tools),
		resources: Object.freeze(resources),
		resourceTemplates: Object.freeze(resourceTemplates),
		prompts: Object.freeze(prompts),
	});
}

async function aggregatePages<Value>(
	load: (
		cursor: string | undefined,
	) => Promise<{ readonly items: readonly Value[]; readonly nextCursor?: string }>,
	maxPages: number,
	signal: AbortSignal,
): Promise<Value[]> {
	const result: Value[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
		signal.throwIfAborted();
		const page = await load(cursor);
		result.push(...page.items);
		if (page.nextCursor === undefined || page.nextCursor.length === 0) return result;
		if (cursors.has(page.nextCursor)) throw new TypeError("catalog cursor repeated");
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new RangeError("catalog page limit exceeded");
}

function outcome(
	status: McpConformanceCheckOutcome["status"],
	code: string,
	facts?: McpConformanceCheckOutcome["facts"],
): McpConformanceCheckOutcome {
	return Object.freeze({ status, code, ...(facts === undefined ? {} : { facts }) });
}

function catalogCounts(catalog: SafeDiscoveryCatalog): Record<string, number> {
	return {
		toolCount: catalog.tools.length,
		resourceCount: catalog.resources.length,
		resourceTemplateCount: catalog.resourceTemplates.length,
		promptCount: catalog.prompts.length,
	};
}

/**
 * Reports how many identities repeat. `digestMcpRuntimeCatalog` refuses a
 * repeated identity outright, so the count this check publishes stays here.
 */
function countDuplicates(catalog: SafeDiscoveryCatalog): number {
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

/**
 * Counts inspected schemas so one hostile catalog cannot spend the run on
 * compilation. Every other schema bound is a capture limit enforced upstream.
 */
interface ToolSchemaBudget {
	schemaCount: number;
}

class ToolSchemaBudgetExceededError extends Error {}

function createToolSchemaBudget(): ToolSchemaBudget {
	return { schemaCount: 0 };
}

function toolSchemaCompiles(
	schema: McpClientToolInputSchema | McpClientToolOutputSchema,
	budget: ToolSchemaBudget,
): boolean {
	budget.schemaCount += 1;
	if (budget.schemaCount > MAX_INSPECTED_SCHEMAS) {
		throw new ToolSchemaBudgetExceededError("tool schema count budget exceeded");
	}
	try {
		captureMcpConformanceValue(schema, TOOL_SCHEMA_CAPTURE_LIMITS);
		createMcpClientToolSchema(schema);
		return true;
	} catch {
		return false;
	}
}
