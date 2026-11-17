import { types as nodeTypes } from "node:util";

import {
	captureBounded,
	isCapturedObject,
	type McpConformanceCapturedObject,
	type McpConformanceCapturedValue,
} from "./capture.ts";
import { catalogRejectedError } from "./errors.ts";
import {
	assertMcpConformanceDomain,
	canonicalizeMcpConformanceValue,
	fingerprintMcpConformanceValue,
} from "./fingerprint.ts";
import { resolveMcpConformanceCaptureLimits, type McpConformanceCaptureLimits } from "./limits.ts";

const MAX_URI_IDENTITY_BYTES = 4_096;
const MAX_NAME_IDENTITY_BYTES = 256;
const CONTROL_CHARACTER = /\p{C}/u;
const textEncoder = new TextEncoder();

/**
 * Structural view of a discovered MCP catalog. It deliberately mirrors the
 * manager's `McpRuntimeCatalogSnapshot` by shape instead of importing it, so
 * this kernel keeps no dependency on a runtime package.
 */
export interface McpConformanceCatalogSnapshot {
	readonly tools: readonly McpConformanceCatalogTool[];
	readonly resources: readonly McpConformanceCatalogResource[];
	readonly resourceTemplates: readonly McpConformanceCatalogResourceTemplate[];
	readonly prompts: readonly McpConformanceCatalogPrompt[];
}

export interface McpConformanceCatalogTool {
	readonly name: string;
	readonly inputSchema: unknown;
	readonly outputSchema?: unknown;
}

export interface McpConformanceCatalogResource {
	readonly uri: string;
}

export interface McpConformanceCatalogResourceTemplate {
	readonly uriTemplate: string;
}

export interface McpConformanceCatalogPrompt {
	readonly name: string;
}

export interface McpConformanceCatalogDigestOptions {
	/** Fingerprint domain for the whole canonical catalog. */
	readonly domain: string;
	/** Fingerprint domain for each individual tool input schema. */
	readonly toolSchemaDomain: string;
	readonly limits?: McpConformanceCaptureLimits;
}

export interface McpConformanceToolDigest {
	readonly name: string;
	readonly schemaDigest: string;
}

export interface McpConformanceCatalogDigest {
	readonly catalogFingerprint: string;
	readonly tools: readonly McpConformanceToolDigest[];
}

/**
 * Digests a discovered catalog into one stable identity plus a per-tool schema
 * digest, so a management path and a serving path can compare the same surface.
 *
 * The whole catalog is captured under caller-supplied bounds before anything is
 * walked twice, discovery order is erased by sorting each collection on its
 * identity with a canonical-form tiebreak, and a repeated identity is refused
 * rather than silently collapsed. Fingerprints keep the package's
 * `sha256:<base64url>` form; `toMcpConformanceFingerprintHex` renders the
 * 64-character lowercase hexadecimal form that digest columns usually check.
 */
export function digestMcpRuntimeCatalog(
	snapshot: McpConformanceCatalogSnapshot,
	options: McpConformanceCatalogDigestOptions,
): McpConformanceCatalogDigest {
	assertMcpConformanceDomain(options?.domain, "options.domain");
	assertMcpConformanceDomain(options?.toolSchemaDomain, "options.toolSchemaDomain");
	const limits = resolveMcpConformanceCaptureLimits(options.limits);
	if (snapshot === null || typeof snapshot !== "object" || nodeTypes.isProxy(snapshot)) {
		throw catalogRejectedError("the snapshot must be an object");
	}

	const captured = captureBounded(
		{
			prompts: ownDataValue(snapshot, "prompts"),
			resourceTemplates: ownDataValue(snapshot, "resourceTemplates"),
			resources: ownDataValue(snapshot, "resources"),
			tools: ownDataValue(snapshot, "tools"),
		},
		limits,
	);
	if (!isCapturedObject(captured.value))
		throw catalogRejectedError("the snapshot must be an object");

	const prompts = catalogItems(captured.value, "prompts");
	const resourceTemplates = catalogItems(captured.value, "resourceTemplates");
	const resources = catalogItems(captured.value, "resources");
	const tools = catalogItems(captured.value, "tools");
	if (
		prompts.length + resourceTemplates.length + resources.length + tools.length >
		limits.maxItems
	) {
		throw catalogRejectedError("the catalog holds too many items");
	}

	const canonicalCatalog = {
		prompts: sortCatalogItems(prompts, "name", MAX_NAME_IDENTITY_BYTES),
		resourceTemplates: sortCatalogItems(resourceTemplates, "uriTemplate", MAX_URI_IDENTITY_BYTES),
		resources: sortCatalogItems(resources, "uri", MAX_URI_IDENTITY_BYTES),
		tools: sortCatalogItems(tools, "name", MAX_NAME_IDENTITY_BYTES),
	};
	const canonical = canonicalizeMcpConformanceValue(canonicalCatalog);
	if (Buffer.byteLength(canonical, "utf8") !== captured.bytes) {
		throw catalogRejectedError("the captured catalog disagrees with its byte accounting");
	}

	const toolDigests = canonicalCatalog.tools.map((tool) =>
		Object.freeze({
			name: identityOf(tool, "name", MAX_NAME_IDENTITY_BYTES),
			schemaDigest: fingerprintMcpConformanceValue(
				dataValueOf(tool, "inputSchema"),
				options.toolSchemaDomain,
			),
		}),
	);
	return Object.freeze({
		catalogFingerprint: fingerprintMcpConformanceValue(canonicalCatalog, options.domain),
		tools: Object.freeze(toolDigests),
	});
}

function catalogItems(
	catalog: McpConformanceCapturedObject,
	key: "tools" | "resources" | "resourceTemplates" | "prompts",
): readonly McpConformanceCapturedObject[] {
	const items = catalog[key];
	if (!Array.isArray(items)) throw catalogRejectedError(`${key} must be an array`);
	return items.map((item: McpConformanceCapturedValue) => {
		if (!isCapturedObject(item)) throw catalogRejectedError(`${key} entries must be objects`);
		return item;
	});
}

/** Erases discovery order deterministically and refuses a repeated identity. */
function sortCatalogItems(
	items: readonly McpConformanceCapturedObject[],
	identityKey: string,
	maximumIdentityBytes: number,
): readonly McpConformanceCapturedObject[] {
	const ordered = items
		.map((item) => ({
			canonical: canonicalizeMcpConformanceValue(item),
			identity: identityOf(item, identityKey, maximumIdentityBytes),
			item,
		}))
		.toSorted(
			(left, right) =>
				compareCodeUnits(left.identity, right.identity) ||
				compareCodeUnits(left.canonical, right.canonical),
		);
	for (let index = 1; index < ordered.length; index += 1) {
		if (ordered[index]?.identity === ordered[index - 1]?.identity) {
			throw catalogRejectedError("catalog identities must be unique");
		}
	}
	return Object.freeze(ordered.map(({ item }) => item));
}

function identityOf(item: McpConformanceCapturedObject, key: string, maximumBytes: number): string {
	const value = dataValueOf(item, key);
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.trim() ||
		value.normalize("NFC") !== value ||
		CONTROL_CHARACTER.test(value) ||
		textEncoder.encode(value).byteLength > maximumBytes
	) {
		throw catalogRejectedError(`${key} must be a bounded printable identity`);
	}
	return value;
}

function dataValueOf(item: McpConformanceCapturedObject, key: string): McpConformanceCapturedValue {
	const value = item[key];
	if (value === undefined) throw catalogRejectedError(`${key} is required`);
	return value;
}

function ownDataValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || !("value" in descriptor)) {
		throw catalogRejectedError(`${key} must be an own data property`);
	}
	return descriptor.value;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
