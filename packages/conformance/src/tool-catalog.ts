import { captureMcpConformanceValue, isCapturedObject } from "./capture.ts";
import { fingerprintMcpConformanceValue } from "./fingerprint.ts";
import {
	MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
	type McpConformanceCaptureLimits,
} from "./limits.ts";

/** Structural MCP definition; protocol SDK extensions are preserved by bounded capture. */
export interface McpConformanceToolDefinition {
	readonly name: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
}

export interface McpToolCatalogOptions {
	readonly limits?: McpConformanceCaptureLimits;
	/** Additional per-definition budget within the collection budget. */
	readonly definitionLimits?: McpConformanceCaptureLimits;
	/** Host-supported name length in UTF-16 code units, bounded by the MCP definition ceiling. */
	readonly maxNameLength?: number;
}

export interface McpToolCatalogSelection<Definition extends McpConformanceToolDefinition> {
	readonly ambiguousNames: readonly string[];
	readonly tools: readonly Readonly<{ name: string; toolDefinition: Definition }>[];
}

export type McpCatalogToolSelection<Definition extends McpConformanceToolDefinition> =
	| Readonly<{ status: "missing" }>
	| Readonly<{ status: "ambiguous" }>
	| Readonly<{ status: "selected"; tool: Readonly<{ name: string; toolDefinition: Definition }> }>;

/** Detached immutable copy of a typed protocol definition, never a truncated schema. */
export function captureMcpToolDefinition<Definition extends McpConformanceToolDefinition>(
	value: Definition,
	limits: McpConformanceCaptureLimits = MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
): Definition {
	const captured = captureMcpConformanceValue(value, limits);
	if (
		!isCapturedObject(captured) ||
		typeof captured.name !== "string" ||
		!isCapturedObject(captured.inputSchema) ||
		(captured.outputSchema !== undefined && !isCapturedObject(captured.outputSchema))
	) {
		throw new TypeError("The MCP tool definition is invalid.");
	}
	// Capture preserves the typed definition's JSON fields while rejecting executable/exotic values.
	return captured as unknown as Definition;
}

/** Resolve ambiguity before host usage filters, so a filtered duplicate never becomes authority. */
export function selectMcpCatalogTools<Definition extends McpConformanceToolDefinition>(
	catalog: Readonly<{ tools: readonly Definition[] }>,
	options: McpToolCatalogOptions = {},
): McpToolCatalogSelection<Definition> {
	const maximum = options.maxNameLength ?? 256;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
		throw new RangeError("The MCP tool name limit must be between 1 and 256.");
	}
	// Capture the collection before accessing provider-owned names or walking it more than once.
	const snapshot = captureMcpConformanceValue(
		catalog,
		options.limits ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
	);
	const captured = isCapturedObject(snapshot) ? snapshot.tools : undefined;
	if (!Array.isArray(captured)) throw new TypeError("The MCP tools must be an array.");
	const candidates: Array<Readonly<{ name: string; toolDefinition: Definition }>> = [];
	const values: readonly unknown[] = captured;
	for (const item of values) {
		if (!isCapturedObject(item) || typeof item.name !== "string")
			throw new TypeError("The MCP tool definition is invalid.");
		if (item.name.length === 0 || item.name.length > maximum) continue;
		if (
			!isCapturedObject(item.inputSchema) ||
			(item.outputSchema !== undefined && !isCapturedObject(item.outputSchema))
		) {
			throw new TypeError("The MCP tool definition is invalid.");
		}
		// The captured array retains the caller's typed protocol definition shape.
		candidates.push(
			Object.freeze({
				name: item.name,
				toolDefinition:
					options.definitionLimits === undefined
						? (item as unknown as Definition)
						: captureMcpToolDefinition(item as unknown as Definition, options.definitionLimits),
			}),
		);
	}
	const counts = new Map<string, number>();
	for (const { name } of candidates) counts.set(name, (counts.get(name) ?? 0) + 1);
	const ambiguousNames = [...counts]
		.filter(([, count]) => count > 1)
		.map(([name]) => name)
		.toSorted(compare);
	const ambiguous = new Set(ambiguousNames);
	return Object.freeze({
		ambiguousNames: Object.freeze(ambiguousNames),
		tools: Object.freeze(
			candidates
				.filter(({ name }) => !ambiguous.has(name))
				.toSorted((a, b) => compare(a.name, b.name)),
		),
	});
}

export function selectMcpCatalogTool<Definition extends McpConformanceToolDefinition>(
	catalog: Readonly<{ tools: readonly Definition[] }>,
	name: string,
	options?: McpToolCatalogOptions,
): McpCatalogToolSelection<Definition> {
	const selection = selectMcpCatalogTools(catalog, options);
	if (selection.ambiguousNames.includes(name)) return Object.freeze({ status: "ambiguous" });
	const tool = selection.tools.find((item) => item.name === name);
	return tool === undefined
		? Object.freeze({ status: "missing" })
		: Object.freeze({ status: "selected", tool });
}

/** Order-independent identity over exact tool names and both input and output schemas. */
export function digestMcpToolSchemas<Definition extends McpConformanceToolDefinition>(
	tools: readonly Definition[],
	options: Readonly<{ domain: string; limits?: McpConformanceCaptureLimits }>,
): string {
	const captured = selectMcpCatalogTools(
		{ tools },
		{ limits: options.limits ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS },
	);
	if (captured.ambiguousNames.length > 0 || captured.tools.length !== tools.length) {
		throw new TypeError("MCP schema identities require unique supported tool names.");
	}
	const schemas = captured.tools.map(({ name, toolDefinition }) => ({
		name,
		inputSchema: toolDefinition.inputSchema,
		outputSchema: toolDefinition.outputSchema ?? null,
	}));
	return fingerprintMcpConformanceValue(
		captureMcpConformanceValue(
			{ schemas, version: 2 },
			options.limits ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS,
		),
		options.domain,
	);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
