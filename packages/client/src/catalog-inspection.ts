import {
	METHOD_NOT_FOUND,
	ProtocolError,
	type Tool,
	type Resource,
	type ResourceTemplateType,
	type Prompt,
} from "@modelcontextprotocol/client";
import {
	captureMcpConformanceValue,
	captureMcpToolArguments,
	type McpPassiveDiscoveryTarget,
} from "@nest-mcp/conformance";
import type { McpClientRuntime } from "./runtime.ts";
import { createMcpClientToolSchema } from "./tool-schema.ts";

export interface McpClientCatalogSnapshot {
	readonly tools: readonly Tool[];
	readonly resources: readonly Resource[];
	readonly resourceTemplates: readonly ResourceTemplateType[];
	readonly prompts: readonly Prompt[];
}

export interface McpClientCatalogInspectionOptions {
	readonly runtime: Pick<McpClientRuntime, "request" | "snapshot">;
	readonly serverName: string;
	readonly signal: AbortSignal;
	readonly maxPages: number;
	readonly maxItems: number;
	/** Parallel waves settle every request before returning. Credential-bound callers use sequential. */
	readonly mode?: "sequential" | "parallel";
}

export class McpClientCatalogLimitError extends Error {
	readonly code = "MCP_CLIENT_CATALOG_LIMIT_EXCEEDED" as const;
	constructor() {
		super("The MCP catalog exceeds its configured page or item limit.");
		this.name = "McpClientCatalogLimitError";
	}
}

const ITEM_LIMITS = Object.freeze({
	maxBytes: 2 * 1_024 * 1_024,
	maxDepth: 64,
	maxItems: 8_192,
	maxProperties: 20_000,
	maxStringBytes: 1_024 * 1_024,
});

/** Fresh bounded protocol traversal on an already acquired runtime; owns no lease or cache. */
export async function discoverMcpClientCatalog(
	input: McpClientCatalogInspectionOptions,
): Promise<McpClientCatalogSnapshot> {
	if (
		![input.maxPages, input.maxItems].every((n) => Number.isSafeInteger(n) && n > 0) ||
		(input.mode !== undefined && input.mode !== "sequential" && input.mode !== "parallel")
	) {
		throw new TypeError("MCP catalog inspection requires positive bounds and a supported mode.");
	}
	const { runtime, serverName, signal } = input;
	signal.throwIfAborted();
	const capabilities = runtime.snapshot(serverName).serverCapabilities;
	let totalItems = 0;
	const account = <Value>(items: readonly Value[]): readonly Value[] => {
		totalItems += items.length;
		if (totalItems > input.maxItems) throw new McpClientCatalogLimitError();
		return items.map((item) => captureMcpConformanceValue(item, ITEM_LIMITS) as Value);
	};
	const tools = () =>
		capabilities?.tools === undefined
			? Promise.resolve([])
			: aggregatePages<Tool>(
					async (cursor) => {
						const page = await runtime.request(
							serverName,
							{ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
							{ signal },
						);
						return {
							items: account(page.tools),
							...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
						};
					},
					input.maxPages,
					signal,
				);
	const resources = () =>
		capabilities?.resources === undefined
			? Promise.resolve([])
			: aggregatePages<Resource>(
					async (cursor) => {
						const page = await runtime.request(
							serverName,
							{ method: "resources/list", params: cursor === undefined ? {} : { cursor } },
							{ signal },
						);
						return {
							items: account(page.resources),
							...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
						};
					},
					input.maxPages,
					signal,
				);
	const resourceTemplates = async (): Promise<readonly ResourceTemplateType[]> => {
		if (capabilities?.resources === undefined) return [];
		try {
			return await aggregatePages<ResourceTemplateType>(
				async (cursor) => {
					const page = await runtime.request(
						serverName,
						{ method: "resources/templates/list", params: cursor === undefined ? {} : { cursor } },
						{ signal },
					);
					return {
						items: account(page.resourceTemplates),
						...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
					};
				},
				input.maxPages,
				signal,
			);
		} catch (error) {
			signal.throwIfAborted();
			if (ProtocolError.isInstance(error) && error.code === METHOD_NOT_FOUND) return [];
			throw error;
		}
	};
	const prompts = () =>
		capabilities?.prompts === undefined
			? Promise.resolve([])
			: aggregatePages<Prompt>(
					async (cursor) => {
						const page = await runtime.request(
							serverName,
							{ method: "prompts/list", params: cursor === undefined ? {} : { cursor } },
							{ signal },
						);
						return {
							items: account(page.prompts),
							...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
						};
					},
					input.maxPages,
					signal,
				);
	let catalog: McpClientCatalogSnapshot;
	if (input.mode === "parallel") {
		const [t, r, rt, p] = await Promise.allSettled([
			tools(),
			resources(),
			resourceTemplates(),
			prompts(),
		]);
		catalog = {
			tools: settledValue(t),
			resources: settledValue(r),
			resourceTemplates: settledValue(rt),
			prompts: settledValue(p),
		};
	} else {
		catalog = {
			tools: await tools(),
			resources: await resources(),
			resourceTemplates: await resourceTemplates(),
			prompts: await prompts(),
		};
	}
	signal.throwIfAborted();
	return Object.freeze({
		tools: Object.freeze(catalog.tools),
		resources: Object.freeze(catalog.resources),
		resourceTemplates: Object.freeze(catalog.resourceTemplates),
		prompts: Object.freeze(catalog.prompts),
	});
}

/** Per-run diagnostic target. It shares discovery across checks and never opens a nested lease. */
export function createMcpClientInspectionTarget(
	input: Omit<McpClientCatalogInspectionOptions, "signal" | "mode"> & {
		readonly leaseSignal: AbortSignal;
	},
): McpPassiveDiscoveryTarget {
	let catalogTask: Promise<McpClientCatalogSnapshot> | undefined;
	return Object.freeze({
		snapshot: () => input.runtime.snapshot(input.serverName),
		async ping(signal: AbortSignal): Promise<void> {
			await input.runtime.request(
				input.serverName,
				{ method: "ping" },
				{ signal: AbortSignal.any([input.leaseSignal, signal]) },
			);
		},
		catalog(signal: AbortSignal): Promise<McpClientCatalogSnapshot> {
			input.leaseSignal.throwIfAborted();
			signal.throwIfAborted();
			catalogTask ??= discoverMcpClientCatalog({
				...input,
				signal: AbortSignal.any([input.leaseSignal, signal]),
				mode: "sequential",
			});
			return catalogTask;
		},
		schemaCompiles(schema: unknown): boolean {
			try {
				const captured = captureMcpToolArguments(schema, ITEM_LIMITS);
				if (captured.type !== "object") return false;
				createMcpClientToolSchema({ ...captured, type: "object" });
				return true;
			} catch {
				return false;
			}
		},
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
	for (let index = 0; index < maxPages; index += 1) {
		signal.throwIfAborted();
		const page = await load(cursor);
		signal.throwIfAborted();
		result.push(...page.items);
		if (page.nextCursor === undefined || page.nextCursor.length === 0) return result;
		if (cursors.has(page.nextCursor)) throw new TypeError("The MCP catalog cursor repeated.");
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new McpClientCatalogLimitError();
}

function settledValue<Value>(result: PromiseSettledResult<Value>): Value {
	if (result.status === "rejected") throw result.reason;
	return result.value;
}
