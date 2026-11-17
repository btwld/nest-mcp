import {
	fromJsonSchema,
	ProtocolError,
	ProtocolErrorCode,
	specTypeSchemas,
} from "@modelcontextprotocol/server";
import type {
	CallToolResult,
	ListToolsResult,
	McpServer,
	RegisteredTool,
	StandardSchemaWithJSON,
	Tool,
} from "@modelcontextprotocol/server";
import type { McpServerBuildContext } from "@nest-mcp/server";
import { McpModuleError } from "./mcp.errors.ts";
import {
	MCP_CATALOG_SCHEMAS_TOOL_NAME,
	MCP_CATALOG_SEARCH_TOOL_NAME,
} from "./mcp-catalog-exposure.ts";
import type {
	McpCatalogExposureOptions,
	McpCatalogExposureResolverInput,
	McpCatalogExposureStrategy,
	McpCatalogSearchResultTool,
	McpCatalogTool,
	McpCatalogToolSelector,
} from "./mcp-catalog-exposure.ts";

export const MCP_CATALOG_MAX_TOOLS = 10_000;
export const MCP_CATALOG_LIST_PAGE_SIZE = 50;
export const MCP_CATALOG_SEARCH_DEFAULT_LIMIT = 20;
export const MCP_CATALOG_SEARCH_MAX_LIMIT = 50;
export const MCP_CATALOG_SCHEMA_BATCH_LIMIT = 20;
export const MCP_CATALOG_INPUT_BYTE_LIMIT = 16 * 1024;
export const MCP_CATALOG_QUERY_LENGTH_LIMIT = 256;
export const MCP_CATALOG_CURSOR_LENGTH_LIMIT = 512;
export const MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT = 128;

const CATALOG_SELECTOR_LIMIT = 64;
const CATALOG_METADATA_BYTE_LIMIT = 8 * 1024;
const CATALOG_JSON_DEPTH_LIMIT = 16;
const EMPTY_INPUT_SCHEMA = Object.freeze({
	type: "object",
	properties: Object.freeze({}),
}) satisfies Tool["inputSchema"];

export interface McpCatalogRegisteredTool {
	readonly name: string;
	readonly registration: RegisteredTool;
	readonly tags: readonly string[];
}

export interface McpCatalogMetaToolDefinition {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: StandardSchemaWithJSON;
	readonly outputSchema: StandardSchemaWithJSON;
	readonly handler: unknown;
}

export type McpCatalogMetaToolRegistrar = (
	definition: McpCatalogMetaToolDefinition,
) => RegisteredTool;

interface CatalogEntry {
	readonly tool: Tool;
	readonly publicTool: McpCatalogTool;
	readonly registration: RegisteredTool;
}

interface NormalizedSearchExposure {
	readonly kind: "search";
	readonly eager: readonly McpCatalogToolSelector[];
	readonly deferredMetadata: Readonly<Record<string, unknown>>;
}

interface NormalizedLazyExposure {
	readonly kind: "lazy";
	readonly eager: readonly McpCatalogToolSelector[];
}

type NormalizedExposure =
	{ readonly kind: "eager" } | NormalizedSearchExposure | NormalizedLazyExposure;

interface SearchInput {
	readonly query?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

interface SearchOutput {
	readonly tools: readonly McpCatalogSearchResultTool[];
	readonly nextCursor?: string;
}

interface SchemasInput {
	readonly names: readonly string[];
}

interface CursorEnvelope {
	readonly v: 1;
	readonly kind: "list" | "search";
	readonly offset: number;
	readonly binding?: string;
}

const SEARCH_INPUT_SCHEMA = fromJsonSchema<SearchInput>({
	type: "object",
	properties: {
		query: { type: "string", maxLength: MCP_CATALOG_QUERY_LENGTH_LIMIT },
		cursor: { type: "string", maxLength: MCP_CATALOG_CURSOR_LENGTH_LIMIT },
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MCP_CATALOG_SEARCH_MAX_LIMIT,
		},
	},
	additionalProperties: false,
});

const SCHEMAS_INPUT_SCHEMA = fromJsonSchema<SchemasInput>({
	type: "object",
	properties: {
		names: {
			type: "array",
			items: { type: "string", minLength: 1, maxLength: MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT },
			minItems: 1,
			maxItems: MCP_CATALOG_SCHEMA_BATCH_LIMIT,
			uniqueItems: true,
		},
	},
	required: ["names"],
	additionalProperties: false,
});

const SEARCH_OUTPUT_SCHEMA = fromJsonSchema<SearchOutput>({
	type: "object",
	properties: {
		tools: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
				},
				required: ["name", "tags"],
				additionalProperties: false,
			},
			maxItems: MCP_CATALOG_SEARCH_MAX_LIMIT,
		},
		nextCursor: { type: "string", maxLength: MCP_CATALOG_CURSOR_LENGTH_LIMIT },
	},
	required: ["tools"],
	additionalProperties: false,
});

const SCHEMAS_OUTPUT_SCHEMA = standardSchemaWithJson(specTypeSchemas.ListToolsResult);

export function assertMcpCatalogExposureOptions(
	options: McpCatalogExposureOptions,
	runtimeName: string,
): void {
	if (typeof options !== "object" || options === null || typeof options.resolver !== "function") {
		throw catalogError(
			`MCP catalog exposure for server "${runtimeName}" requires a resolver function.`,
		);
	}
}

/** Applies one strategy to only the exact post-visibility registrations owned by this build. */
export async function applyMcpCatalogExposure(
	server: McpServer,
	context: McpServerBuildContext,
	registrations: readonly McpCatalogRegisteredTool[],
	options: McpCatalogExposureOptions,
	timeoutMs: number,
	registerMetaTool: McpCatalogMetaToolRegistrar,
): Promise<void> {
	try {
		if (registrations.length > MCP_CATALOG_MAX_TOOLS) {
			throw catalogError(
				`MCP catalog for server "${context.runtimeName}" exceeds ${String(MCP_CATALOG_MAX_TOOLS)} visible tools.`,
			);
		}
		const entries = Object.freeze(
			registrations
				.filter(({ registration }) => registration.enabled)
				.map((registration) => snapshotEntry(registration)),
		);
		const resolverInput = snapshotResolverInput(context, entries);
		const resolved = await resolveWithinDeadline(
			options.resolver,
			resolverInput,
			timeoutMs,
			context.requestInfo?.signal,
		);
		const strategy = normalizeStrategy(resolved, context.runtimeName);
		if (strategy.kind === "eager") return;

		const eager = selectEagerEntries(entries, strategy.eager, context.runtimeName);
		if (strategy.kind === "search") {
			applyDeferredMetadata(entries, eager, strategy.deferredMetadata, context.runtimeName);
			return;
		}
		await installLazyCatalog(server, entries, eager, registerMetaTool);
	} catch (cause) {
		if (cause instanceof McpModuleError && cause.code === "INVALID_CATALOG_EXPOSURE") {
			throw cause;
		}
		throw catalogError(
			`MCP catalog exposure failed closed for server "${context.runtimeName}".`,
			cause,
		);
	}
}

function snapshotEntry(registration: McpCatalogRegisteredTool): CatalogEntry {
	const tool = projectRegisteredTool(registration.name, registration.registration);
	const tags = detachJson(registration.tags, "MCP catalog tags");
	const publicTool = Object.freeze({ tool, tags }) as McpCatalogTool;
	return Object.freeze({
		tool,
		publicTool,
		registration: registration.registration,
	});
}

function projectRegisteredTool(name: string, registration: RegisteredTool): Tool {
	const projected = {
		name,
		...(registration.title === undefined ? {} : { title: registration.title }),
		...(registration.description === undefined ? {} : { description: registration.description }),
		inputSchema:
			registration.inputSchema === undefined
				? EMPTY_INPUT_SCHEMA
				: toInputJsonSchema(registration.inputSchema),
		...(registration.outputSchema === undefined
			? {}
			: { outputSchema: toOutputJsonSchema(registration.outputSchema) }),
		...(registration.annotations === undefined ? {} : { annotations: registration.annotations }),
		...(registration.icons === undefined ? {} : { icons: registration.icons }),
		...(registration.execution === undefined ? {} : { execution: registration.execution }),
		...(registration["_meta"] === undefined ? {} : { _meta: registration["_meta"] }),
	} satisfies Tool;
	return detachJson(projected, `MCP tool "${name}"`);
}

function toInputJsonSchema(schema: StandardSchemaWithJSON): Tool["inputSchema"] {
	const converted = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
	if (!isPlainRecord(converted)) {
		throw catalogError("MCP tool input schema must convert to a JSON Schema object.");
	}
	if (converted.type !== undefined && converted.type !== "object") {
		throw catalogError("MCP tool input schema must describe an object at its root.");
	}
	return { type: "object", ...converted };
}

function toOutputJsonSchema(schema: StandardSchemaWithJSON): NonNullable<Tool["outputSchema"]> {
	const converted = schema["~standard"].jsonSchema.output({ target: "draft-2020-12" });
	if (!isPlainRecord(converted)) {
		throw catalogError("MCP tool output schema must convert to a JSON Schema object.");
	}
	return {
		...(converted.type === undefined && isObjectShapedSchema(converted) ? { type: "object" } : {}),
		...converted,
	};
}

function isObjectShapedSchema(schema: Record<string, unknown>): boolean {
	if (
		"properties" in schema ||
		"patternProperties" in schema ||
		"additionalProperties" in schema ||
		"required" in schema
	) {
		return true;
	}
	for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
		const members = schema[keyword];
		if (
			Array.isArray(members) &&
			members.length > 0 &&
			members.every(
				(member) =>
					isPlainRecord(member) && (member.type === "object" || isObjectShapedSchema(member)),
			)
		) {
			return true;
		}
	}
	return false;
}

function snapshotResolverInput(
	context: McpServerBuildContext,
	entries: readonly CatalogEntry[],
): McpCatalogExposureResolverInput {
	const principal =
		context.principal === undefined
			? undefined
			: Object.freeze({
					...context.principal,
					scopes: Object.freeze([...context.principal.scopes]),
				});
	return Object.freeze({
		runtimeName: context.runtimeName,
		era: context.era,
		...(principal === undefined ? {} : { principal }),
		...(context.requestInfo?.signal === undefined ? {} : { signal: context.requestInfo.signal }),
		tools: Object.freeze(entries.map(({ publicTool }) => publicTool)),
	});
}

async function resolveWithinDeadline(
	resolver: McpCatalogExposureOptions["resolver"],
	input: McpCatalogExposureResolverInput,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<McpCatalogExposureStrategy> {
	const task = Promise.resolve().then(() => resolver(input));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => {
			finish(() =>
				reject(
					catalogError(
						"MCP catalog exposure resolver was aborted before the build completed.",
						signal?.reason,
					),
				),
			);
		};
		const timer = setTimeout(() => {
			finish(() =>
				reject(
					catalogError(
						`MCP catalog exposure resolver exceeded its ${String(timeoutMs)}ms deadline.`,
					),
				),
			);
		}, timeoutMs);
		task.then(
			(value) => finish(() => resolve(value)),
			(cause: unknown) =>
				finish(() =>
					reject(catalogError("MCP catalog exposure resolver threw or rejected.", cause)),
				),
		);
		if (signal?.aborted === true) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeStrategy(
	value: McpCatalogExposureStrategy,
	runtimeName: string,
): NormalizedExposure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw catalogError(
			`MCP catalog resolver for server "${runtimeName}" must return a strategy object.`,
		);
	}
	if (value.kind === "eager") return Object.freeze({ kind: "eager" });
	if (value.kind === "search") {
		return Object.freeze({
			kind: "search",
			eager: normalizeSelectors(value.eager),
			deferredMetadata: normalizeDeferredMetadata(value.deferredMetadata),
		});
	}
	if (value.kind === "lazy") {
		return Object.freeze({ kind: "lazy", eager: normalizeSelectors(value.eager) });
	}
	throw catalogError(
		`MCP catalog resolver for server "${runtimeName}" returned an undeclared strategy kind.`,
	);
}

function normalizeSelectors(
	selectors: readonly McpCatalogToolSelector[] | undefined,
): readonly McpCatalogToolSelector[] {
	if (selectors === undefined) return Object.freeze([]);
	if (!Array.isArray(selectors) || selectors.length > CATALOG_SELECTOR_LIMIT) {
		throw catalogError(
			`MCP catalog eager selectors must contain at most ${String(CATALOG_SELECTOR_LIMIT)} entries.`,
		);
	}
	return Object.freeze(
		selectors.map((selector, index) => {
			if (typeof selector !== "object" || selector === null) {
				throw catalogError(`MCP catalog selector at index ${String(index)} must be an object.`);
			}
			if (selector.kind === "name") {
				const name = normalizeBoundedString(
					selector.name,
					MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT,
					`MCP catalog name selector at index ${String(index)}`,
				);
				return Object.freeze({ kind: "name", name });
			}
			if (selector.kind === "tag") {
				const tag = normalizeBoundedString(
					selector.tag,
					64,
					`MCP catalog tag selector at index ${String(index)}`,
				);
				return Object.freeze({ kind: "tag", tag });
			}
			if (selector.kind === "predicate" && typeof selector.predicate === "function") {
				return Object.freeze({ kind: "predicate", predicate: selector.predicate });
			}
			throw catalogError(`MCP catalog selector at index ${String(index)} is invalid.`);
		}),
	);
}

function normalizeDeferredMetadata(value: unknown): Readonly<Record<string, unknown>> {
	const detached = detachJson(
		value,
		"MCP search exposure deferredMetadata",
		CATALOG_METADATA_BYTE_LIMIT,
	);
	if (!isPlainRecord(detached) || Object.keys(detached).length === 0) {
		throw catalogError("MCP search exposure deferredMetadata must be a non-empty JSON object.");
	}
	return detached;
}

function selectEagerEntries(
	entries: readonly CatalogEntry[],
	selectors: readonly McpCatalogToolSelector[],
	runtimeName: string,
): ReadonlySet<CatalogEntry> {
	const selected = new Set<CatalogEntry>();
	for (const entry of entries) {
		for (const selector of selectors) {
			let matches: boolean;
			if (selector.kind === "name") matches = entry.tool.name === selector.name;
			else if (selector.kind === "tag") matches = entry.publicTool.tags.includes(selector.tag);
			else {
				let decision: unknown;
				try {
					decision = selector.predicate(entry.publicTool);
				} catch (cause) {
					throw catalogError(
						`MCP catalog predicate selector threw for tool "${entry.tool.name}" on server "${runtimeName}".`,
						cause,
					);
				}
				if (typeof decision !== "boolean") {
					throw catalogError(
						`MCP catalog predicate selector returned ${typeof decision} instead of boolean for tool "${entry.tool.name}" on server "${runtimeName}".`,
					);
				}
				matches = decision;
			}
			if (matches) {
				selected.add(entry);
				break;
			}
		}
	}
	return selected;
}

function applyDeferredMetadata(
	entries: readonly CatalogEntry[],
	eager: ReadonlySet<CatalogEntry>,
	metadata: Readonly<Record<string, unknown>>,
	runtimeName: string,
): void {
	for (const entry of entries) {
		if (eager.has(entry)) continue;
		// Merge from the detached pre-resolver snapshot, never a mutable SDK handle reread.
		const existing = entry.tool["_meta"] ?? {};
		for (const key of Object.keys(metadata)) {
			if (Object.hasOwn(existing, key)) {
				throw catalogError(
					`MCP deferred metadata key "${key}" collides with existing _meta on tool "${entry.tool.name}" for server "${runtimeName}".`,
				);
			}
		}
		const merged = detachJson(
			{ ...existing, ...metadata },
			`MCP deferred metadata for tool "${entry.tool.name}"`,
		);
		entry.registration.update({ _meta: merged });
	}
}

async function installLazyCatalog(
	server: McpServer,
	entries: readonly CatalogEntry[],
	eager: ReadonlySet<CatalogEntry>,
	registerMetaTool: McpCatalogMetaToolRegistrar,
): Promise<void> {
	const searchRegistration = registerMetaTool({
		name: MCP_CATALOG_SEARCH_TOOL_NAME,
		title: "Search tool catalog",
		description: "Search the authorized tool catalog using bounded, paginated summaries.",
		inputSchema: SEARCH_INPUT_SCHEMA,
		outputSchema: SEARCH_OUTPUT_SCHEMA,
		handler: async (input: SearchInput): Promise<CallToolResult> =>
			createSearchResult(entries, input),
	});
	const schemasRegistration = registerMetaTool({
		name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
		title: "Fetch tool schemas",
		description: "Fetch complete definitions for a bounded batch of authorized tools.",
		inputSchema: SCHEMAS_INPUT_SCHEMA,
		outputSchema: SCHEMAS_OUTPUT_SCHEMA,
		handler: async (input: SchemasInput): Promise<CallToolResult> =>
			createSchemasResult(entries, input),
	});
	const listed = [
		...entries.filter((entry) => eager.has(entry)).map(({ tool }) => tool),
		projectRegisteredTool(MCP_CATALOG_SEARCH_TOOL_NAME, searchRegistration),
		projectRegisteredTool(MCP_CATALOG_SCHEMAS_TOOL_NAME, schemasRegistration),
	];
	const binding = await cursorBinding(
		"list",
		listed.map(({ name }) => name),
	);
	server.server.setRequestHandler("tools/list", (request): ListToolsResult => {
		const offset = decodeCursor(request.params?.cursor, "list", binding).offset;
		const tools = listed.slice(offset, offset + MCP_CATALOG_LIST_PAGE_SIZE);
		const nextOffset = offset + tools.length;
		return {
			tools,
			...(nextOffset < listed.length
				? {
						nextCursor: encodeCursor({
							v: 1,
							kind: "list",
							offset: nextOffset,
							binding,
						}),
					}
				: {}),
		};
	});
}

async function createSearchResult(
	entries: readonly CatalogEntry[],
	input: SearchInput,
): Promise<CallToolResult> {
	assertInputSize(input, MCP_CATALOG_SEARCH_TOOL_NAME);
	const query = normalizeSearchQuery(input.query);
	const matches = entries.filter((entry) => matchesSearch(entry.publicTool, query));
	const binding = await cursorBinding("search", [query, ...matches.map(({ tool }) => tool.name)]);
	const cursor = decodeCursor(input.cursor, "search", binding);
	const limit = normalizeSearchLimit(input.limit);
	const tools = matches
		.slice(cursor.offset, cursor.offset + limit)
		.map(({ publicTool }) => summarizeTool(publicTool));
	const nextOffset = cursor.offset + tools.length;
	const structuredContent: Record<string, unknown> = {
		tools,
		...(nextOffset < matches.length
			? {
					nextCursor: encodeCursor({
						v: 1,
						kind: "search",
						offset: nextOffset,
						binding,
					}),
				}
			: {}),
	};
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent) }],
		structuredContent,
	};
}

function createSchemasResult(
	entries: readonly CatalogEntry[],
	input: SchemasInput,
): CallToolResult {
	assertInputSize(input, MCP_CATALOG_SCHEMAS_TOOL_NAME);
	if (!Array.isArray(input.names) || input.names.length > MCP_CATALOG_SCHEMA_BATCH_LIMIT) {
		throw invalidParams(
			`names must contain between 1 and ${String(MCP_CATALOG_SCHEMA_BATCH_LIMIT)} unique tool names.`,
		);
	}
	const byName = new Map(entries.map((entry) => [entry.tool.name, entry.tool]));
	const tools = input.names.flatMap((name) => {
		const tool = byName.get(name);
		return tool === undefined ? [] : [tool];
	});
	const structuredContent: Record<string, unknown> = { tools };
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent) }],
		structuredContent,
	};
}

function summarizeTool(tool: McpCatalogTool): McpCatalogSearchResultTool {
	return Object.freeze({
		name: tool.tool.name,
		...(tool.tool.title === undefined ? {} : { title: tool.tool.title }),
		...(tool.tool.description === undefined ? {} : { description: tool.tool.description }),
		tags: tool.tags,
	});
}

function matchesSearch(tool: McpCatalogTool, query: string): boolean {
	if (query.length === 0) return true;
	return [tool.tool.name, tool.tool.title, tool.tool.description, ...tool.tags]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase().includes(query));
}

function normalizeSearchQuery(value: string | undefined): string {
	if (value === undefined) return "";
	if (typeof value !== "string" || value.length > MCP_CATALOG_QUERY_LENGTH_LIMIT) {
		throw invalidParams(
			`query must contain at most ${String(MCP_CATALOG_QUERY_LENGTH_LIMIT)} characters.`,
		);
	}
	return value.trim().toLowerCase();
}

function normalizeSearchLimit(value: number | undefined): number {
	const limit = value ?? MCP_CATALOG_SEARCH_DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MCP_CATALOG_SEARCH_MAX_LIMIT) {
		throw invalidParams(
			`limit must be an integer between 1 and ${String(MCP_CATALOG_SEARCH_MAX_LIMIT)}.`,
		);
	}
	return limit;
}

function encodeCursor(cursor: CursorEnvelope): string {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `v1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function decodeCursor(
	value: string | undefined,
	kind: CursorEnvelope["kind"],
	binding?: string,
): CursorEnvelope {
	if (value === undefined) {
		return { v: 1, kind, offset: 0, ...(binding === undefined ? {} : { binding }) };
	}
	if (
		typeof value !== "string" ||
		value.length > MCP_CATALOG_CURSOR_LENGTH_LIMIT ||
		!value.startsWith("v1.")
	) {
		throw invalidParams("Invalid MCP catalog cursor.");
	}
	let parsed: unknown;
	try {
		const encoded = value.slice(3).replaceAll("-", "+").replaceAll("_", "/");
		const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
		const binary = atob(encoded + padding);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw invalidParams("Invalid MCP catalog cursor.");
	}
	if (
		!isPlainRecord(parsed) ||
		!hasExactCursorKeys(parsed, binding !== undefined) ||
		parsed.v !== 1 ||
		parsed.kind !== kind ||
		!Number.isSafeInteger(parsed.offset) ||
		typeof parsed.offset !== "number" ||
		parsed.offset < 0 ||
		parsed.offset > MCP_CATALOG_MAX_TOOLS ||
		(binding === undefined ? parsed.binding !== undefined : parsed.binding !== binding)
	) {
		throw invalidParams("Invalid MCP catalog cursor.");
	}
	return {
		v: 1,
		kind,
		offset: parsed.offset,
		...(binding === undefined ? {} : { binding }),
	};
}

function hasExactCursorKeys(cursor: Record<string, unknown>, hasBinding: boolean): boolean {
	const expected = hasBinding ? ["binding", "kind", "offset", "v"] : ["kind", "offset", "v"];
	const actual = Object.keys(cursor).toSorted();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function cursorBinding(
	kind: CursorEnvelope["kind"],
	values: readonly string[],
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify({ kind, values })),
		),
	);
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertInputSize(input: unknown, toolName: string): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(input);
	} catch {
		throw invalidParams(`Input for ${toolName} must be JSON serializable.`);
	}
	if (new TextEncoder().encode(serialized).byteLength > MCP_CATALOG_INPUT_BYTE_LIMIT) {
		throw invalidParams(
			`Input for ${toolName} exceeds ${String(MCP_CATALOG_INPUT_BYTE_LIMIT)} bytes.`,
		);
	}
}

function normalizeBoundedString(value: unknown, maximum: number, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
		throw catalogError(`${label} must contain between 1 and ${String(maximum)} characters.`);
	}
	return value.trim();
}

function detachJson<Value>(value: Value, label: string, maximumBytes?: number): Value {
	let clone: Value;
	try {
		clone = structuredClone(value);
	} catch (cause) {
		throw catalogError(`${label} must be safely detachable.`, cause);
	}
	assertJsonSafe(clone, label, 0, new Set());
	if (maximumBytes !== undefined) {
		const bytes = new TextEncoder().encode(JSON.stringify(clone)).byteLength;
		if (bytes > maximumBytes) {
			throw catalogError(`${label} exceeds ${String(maximumBytes)} serialized bytes.`);
		}
	}
	return deepFreeze(clone);
}

function assertJsonSafe(
	value: unknown,
	label: string,
	depth: number,
	ancestors: Set<object>,
): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw catalogError(`${label} contains a non-finite number.`);
	}
	if (typeof value !== "object") {
		throw catalogError(`${label} contains a non-JSON value.`);
	}
	if (depth >= CATALOG_JSON_DEPTH_LIMIT) {
		throw catalogError(`${label} exceeds the maximum JSON nesting depth.`);
	}
	if (ancestors.has(value)) throw catalogError(`${label} must not contain cycles.`);
	if (!Array.isArray(value) && !isPlainRecord(value)) {
		throw catalogError(`${label} must contain only JSON arrays and objects.`);
	}
	ancestors.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		assertJsonSafe(entry, label, depth + 1, ancestors);
	}
	ancestors.delete(value);
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Array.isArray(value) ? value : Object.values(value)) deepFreeze(entry);
	return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function standardSchemaWithJson(schema: unknown): StandardSchemaWithJSON {
	if (!isStandardSchemaWithJson(schema)) {
		throw new TypeError("Official MCP schema does not expose Standard JSON Schema conversion.");
	}
	return schema;
}

function isStandardSchemaWithJson(value: unknown): value is StandardSchemaWithJSON {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
	const standard: unknown = Reflect.get(value, "~standard");
	if (!isPlainRecord(standard)) return false;
	const jsonSchema = standard.jsonSchema;
	return (
		isPlainRecord(jsonSchema) &&
		typeof jsonSchema.input === "function" &&
		typeof jsonSchema.output === "function" &&
		typeof standard.validate === "function"
	);
}

function invalidParams(message: string): ProtocolError {
	return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function catalogError(message: string, cause?: unknown): McpModuleError {
	return new McpModuleError(
		"INVALID_CATALOG_EXPOSURE",
		message,
		cause === undefined ? undefined : { cause },
	);
}
