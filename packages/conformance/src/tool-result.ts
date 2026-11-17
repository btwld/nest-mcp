import { types as nodeTypes } from "node:util";

import {
	resolveMcpToolResultProjectionLimits,
	type McpToolResultProjectionLimits,
	type ResolvedMcpToolResultProjectionLimits,
} from "./limits.ts";

const POLLUTING_KEY = "__proto__";
const CONTROL_CHARACTER = /\p{C}/u;
const COPIED_STRING_CHUNK_CODE_UNITS = 1_024;

export type McpProjectedToolResultContentBlock =
	| Readonly<{ kind: "text"; text: string; truncated: boolean }>
	| Readonly<{
			kind: "summary";
			contentType: string;
			mediaType?: string;
			bytes?: number;
	  }>;

export interface McpProjectedToolResult {
	readonly isError: boolean;
	readonly content: readonly McpProjectedToolResultContentBlock[];
	readonly structuredContent?: unknown;
	/** True whenever any source value could not be represented completely. */
	readonly truncated: boolean;
}

interface PropertyRead {
	readonly present: boolean;
	readonly rejected: boolean;
	readonly value: unknown;
}

interface StructuredProjection {
	readonly present: boolean;
	readonly truncated: boolean;
	readonly value: unknown;
}

interface ProjectedDescriptor {
	readonly truncated: boolean;
	readonly value: string | undefined;
}

interface ProjectionState {
	readonly ancestors: Set<object>;
	readonly limits: Readonly<ResolvedMcpToolResultProjectionLimits>;
	nodes: number;
	rawStringBytes: number;
	truncated: boolean;
}

/**
 * Lossily projects an untrusted MCP `tools/call` result into bounded JSON data.
 *
 * Text remains text. Binary, embedded-resource, resource-link, and future
 * content blocks become descriptor-only summaries: data and URIs never cross
 * this boundary. Structured content is copied into frozen null-prototype JSON
 * containers under depth, node, string, and serialized-byte bounds. Proxies,
 * enumerable accessors, exotic prototypes, cycles, sparse entries, non-finite
 * numbers, and `__proto__` members are dropped and reported through
 * `truncated`; source getters are never invoked. Symbol and non-enumerable
 * state is outside MCP's enumerable string-key JSON surface and is never
 * enumerated. This bounds emitted data and per-string scans, not the engine's
 * cost to enumerate a previously parsed object's keys; callers must also cap
 * the transport response body before parsing.
 */
export function projectMcpToolResult(
	result: unknown,
	limits?: McpToolResultProjectionLimits,
): Readonly<McpProjectedToolResult> {
	const resolved = resolveMcpToolResultProjectionLimits(limits);
	try {
		return projectResult(result, resolved);
	} catch {
		return degradedMcpToolResult(result);
	}
}

/** A literal, always-serializable fallback for a result that cannot be inspected safely. */
export function degradedMcpToolResult(result?: unknown): Readonly<McpProjectedToolResult> {
	const isError = readOwnDataProperty(result, "isError");
	return Object.freeze({
		content: Object.freeze([]),
		isError: !isError.rejected && isError.value === true,
		truncated: true,
	});
}

function projectResult(
	result: unknown,
	limits: Readonly<ResolvedMcpToolResultProjectionLimits>,
): Readonly<McpProjectedToolResult> {
	let truncated = false;
	const contentRead = readOwnDataProperty(result, "content");
	const blocks = captureBlockArray(contentRead, limits.maxContentBlocks);
	truncated ||= blocks.truncated;

	let textBudget = limits.maxTextBytesTotal;
	const content: McpProjectedToolResultContentBlock[] = [];
	for (const block of blocks.values) {
		if (block.rejected) {
			truncated = true;
			content.push(Object.freeze({ kind: "summary" as const, contentType: "unknown" }));
			continue;
		}
		const contentTypeRead = readOwnDataProperty(block.value, "type");
		const projectedContentType = projectedDescriptor(contentTypeRead, limits);
		const contentType = projectedContentType.value ?? "unknown";
		if (projectedContentType.truncated) truncated = true;
		if (contentType === "text") {
			const textRead = readOwnDataProperty(block.value, "text");
			const source = typeof textRead.value === "string" ? textRead.value : "";
			const textLimit = Math.min(limits.maxTextBytesPerBlock, textBudget);
			const bounded = boundUtf8(source, textLimit);
			textBudget -= bounded.bytes;
			const lost =
				bounded.truncated ||
				textRead.rejected ||
				!textRead.present ||
				typeof textRead.value !== "string";
			if (lost) truncated = true;
			content.push(
				Object.freeze({
					kind: "text" as const,
					text: bounded.value,
					truncated: lost,
				}),
			);
			continue;
		}

		const mediaTypeRead = readOwnDataProperty(block.value, "mimeType");
		const mediaType = projectedDescriptor(mediaTypeRead, limits).value;
		const bytes = declaredByteLength(block.value);
		truncated = true;
		content.push(
			Object.freeze({
				kind: "summary" as const,
				contentType,
				...(mediaType === undefined ? {} : { mediaType }),
				...(bytes === undefined ? {} : { bytes }),
			}),
		);
	}

	const structuredRead = readOwnDataProperty(result, "structuredContent");
	const structured = projectStructuredContent(structuredRead, limits);
	truncated ||= structured.truncated;
	const isErrorRead = readOwnDataProperty(result, "isError");
	truncated ||=
		isErrorRead.rejected || (isErrorRead.present && typeof isErrorRead.value !== "boolean");
	return Object.freeze({
		content: Object.freeze(content),
		isError: isErrorRead.value === true,
		...(structured.present ? { structuredContent: structured.value } : {}),
		truncated,
	});
}

function captureBlockArray(
	read: PropertyRead,
	maximum: number,
): Readonly<{
	readonly values: readonly Readonly<{ value: unknown; rejected: boolean }>[];
	readonly truncated: boolean;
}> {
	if (!read.present || read.rejected || !isPlainArray(read.value)) {
		return Object.freeze({ values: Object.freeze([]), truncated: true });
	}
	const length = arrayLength(read.value);
	if (length === undefined) {
		return Object.freeze({ values: Object.freeze([]), truncated: true });
	}
	const kept = Math.min(length, maximum);
	const values: Readonly<{ value: unknown; rejected: boolean }>[] = [];
	let truncated = length > maximum;
	for (let index = 0; index < kept; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(read.value, String(index));
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			truncated = true;
			values.push(Object.freeze({ value: undefined, rejected: true }));
			continue;
		}
		values.push(Object.freeze({ value: descriptor.value, rejected: false }));
	}
	if (!truncated && hasRejectedArrayProperties(read.value, length)) truncated = true;
	return Object.freeze({ values: Object.freeze(values), truncated });
}

function projectStructuredContent(
	read: PropertyRead,
	limits: Readonly<ResolvedMcpToolResultProjectionLimits>,
): StructuredProjection {
	if (!read.present) {
		return Object.freeze({
			present: false,
			truncated: read.rejected,
			value: undefined,
		});
	}
	if (read.rejected || read.value === undefined) {
		return Object.freeze({ present: false, truncated: true, value: undefined });
	}
	const state: ProjectionState = {
		ancestors: new Set<object>(),
		limits,
		nodes: 0,
		rawStringBytes: 0,
		truncated: false,
	};
	const value = projectStructuredValue(read.value, state, 0);
	const serialized = JSON.stringify(value) ?? "null";
	if (exceedsUtf8ByteLimit(serialized, limits.maxStructuredSerializedBytes)) {
		return Object.freeze({ present: false, truncated: true, value: undefined });
	}
	return Object.freeze({ present: true, truncated: state.truncated, value });
}

function projectStructuredValue(value: unknown, state: ProjectionState, depth: number): unknown {
	state.nodes += 1;
	if (state.nodes > state.limits.maxStructuredNodes) {
		state.truncated = true;
		return null;
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		state.truncated = true;
		return null;
	}
	if (typeof value === "string") {
		const bounded = boundStructuredString(value, state);
		if (bounded.truncated) state.truncated = true;
		return bounded.value;
	}
	if (typeof value !== "object" || nodeTypes.isProxy(value)) {
		state.truncated = true;
		return null;
	}
	if (depth >= state.limits.maxStructuredDepth || state.ancestors.has(value)) {
		state.truncated = true;
		return null;
	}
	const prototype = Object.getPrototypeOf(value);
	const array = Array.isArray(value);
	if (
		(array && prototype !== Array.prototype) ||
		(!array && prototype !== Object.prototype && prototype !== null)
	) {
		state.truncated = true;
		return null;
	}
	state.ancestors.add(value);
	try {
		if (array) return projectStructuredArray(value, state, depth);
		return projectStructuredObject(value, state, depth);
	} finally {
		state.ancestors.delete(value);
	}
}

function projectStructuredArray(
	value: readonly unknown[],
	state: ProjectionState,
	depth: number,
): readonly unknown[] {
	const length = arrayLength(value);
	if (length === undefined) {
		state.truncated = true;
		return Object.freeze([]);
	}
	const output: unknown[] = [];
	const retainedLength = Math.min(
		length,
		Math.max(0, state.limits.maxStructuredNodes - state.nodes),
	);
	if (retainedLength < length) state.truncated = true;
	for (let index = 0; index < retainedLength; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			descriptor.enumerable !== true ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			state.nodes += 1;
			state.truncated = true;
			output.push(null);
			continue;
		}
		output.push(projectStructuredValue(descriptor.value, state, depth + 1));
	}
	if (!state.truncated && hasRejectedArrayProperties(value, length)) state.truncated = true;
	return Object.freeze(output);
}

function projectStructuredObject(
	value: object,
	state: ProjectionState,
	depth: number,
): Readonly<Record<string, unknown>> {
	const output: Record<string, unknown> = Object.create(null);
	for (const key in value) {
		if (state.nodes >= state.limits.maxStructuredNodes) {
			state.truncated = true;
			break;
		}
		if (!Object.hasOwn(value, key) || key === POLLUTING_KEY) {
			state.nodes += 1;
			state.truncated = true;
			continue;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			descriptor.enumerable !== true ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			state.nodes += 1;
			state.truncated = true;
			continue;
		}
		const boundedKey = boundStructuredString(key, state);
		if (boundedKey.truncated) state.truncated = true;
		if (boundedKey.value === POLLUTING_KEY || Object.hasOwn(output, boundedKey.value)) {
			state.nodes += 1;
			state.truncated = true;
			continue;
		}
		output[boundedKey.value] = projectStructuredValue(descriptor.value, state, depth + 1);
	}
	return Object.freeze(output);
}

function boundStructuredString(value: string, state: ProjectionState): BoundedText {
	const remaining = Math.max(0, state.limits.maxStructuredSerializedBytes - state.rawStringBytes);
	const bounded = boundUtf8(value, Math.min(state.limits.maxStructuredStringBytes, remaining));
	state.rawStringBytes += bounded.bytes;
	return bounded;
}

function projectedDescriptor(
	read: PropertyRead,
	limits: Readonly<ResolvedMcpToolResultProjectionLimits>,
): ProjectedDescriptor {
	if (read.rejected || typeof read.value !== "string" || read.value.length === 0) {
		return Object.freeze({
			truncated: read.rejected || (read.present && typeof read.value !== "string"),
			value: undefined,
		});
	}
	const maximum = limits.maxSummaryDescriptorLength;
	// Filtering hostile control-only prefixes is useful, but it must not turn a
	// small output ceiling into a full-source scan.
	const maximumInspectedCodeUnits = maximum * 4;
	let inspectedCodeUnits = 0;
	let output = "";
	let truncated = false;
	for (const character of read.value) {
		if (inspectedCodeUnits + character.length > maximumInspectedCodeUnits) {
			truncated = true;
			break;
		}
		inspectedCodeUnits += character.length;
		if (CONTROL_CHARACTER.test(character)) {
			truncated = true;
			continue;
		}
		if (output.length + character.length > maximum) {
			truncated = true;
			break;
		}
		output += copiedCodePoint(character);
		if (output.length === maximum && inspectedCodeUnits < read.value.length) {
			truncated = true;
			break;
		}
	}
	if (inspectedCodeUnits < read.value.length) truncated = true;
	return Object.freeze({ truncated, value: output.length === 0 ? undefined : output });
}

/** Derives the declared decoded size without materializing binary data. */
function declaredByteLength(block: unknown): number | undefined {
	const read = readOwnDataProperty(block, "data");
	if (read.rejected || typeof read.value !== "string" || read.value.length === 0) {
		return undefined;
	}
	const padding = read.value.endsWith("==") ? 2 : read.value.endsWith("=") ? 1 : 0;
	const bytes = Math.max(0, Math.floor((read.value.length * 3) / 4) - padding);
	return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function readOwnDataProperty(value: unknown, key: string): PropertyRead {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function") ||
		nodeTypes.isProxy(value)
	) {
		return Object.freeze({ present: false, rejected: true, value: undefined });
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) {
			return Object.freeze({ present: false, rejected: false, value: undefined });
		}
		if (descriptor.enumerable !== true || !("value" in descriptor)) {
			return Object.freeze({ present: true, rejected: true, value: undefined });
		}
		return Object.freeze({ present: true, rejected: false, value: descriptor.value });
	} catch {
		return Object.freeze({ present: false, rejected: true, value: undefined });
	}
}

function isPlainArray(value: unknown): value is readonly unknown[] {
	return (
		Array.isArray(value) &&
		!nodeTypes.isProxy(value) &&
		Object.getPrototypeOf(value) === Array.prototype
	);
}

function arrayLength(value: readonly unknown[]): number | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, "length");
	return descriptor !== undefined &&
		"value" in descriptor &&
		Number.isSafeInteger(descriptor.value) &&
		descriptor.value >= 0
		? descriptor.value
		: undefined;
}

function hasRejectedArrayProperties(value: object, length: number): boolean {
	for (const key in value) {
		if (!Object.hasOwn(value, key) || !isCanonicalArrayIndex(key, length)) return true;
	}
	return false;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
	if (key.length === 0 || key.length > 10) return false;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

interface BoundedText {
	readonly bytes: number;
	readonly value: string;
	readonly truncated: boolean;
}

/**
 * Copies bounded text without retaining the hostile source string, splitting
 * a surrogate pair, or scanning the unretained suffix.
 */
function boundUtf8(value: string, maximumBytes: number): BoundedText {
	// UTF-8 uses at least one byte per UTF-16 code unit. Only scan the complete
	// input when that scan is bounded by the caller's output budget.
	if (value.length <= maximumBytes) {
		const bytes = Buffer.byteLength(value, "utf8");
		if (bytes <= maximumBytes) {
			// A UTF-16 round trip detaches sliced-string backing storage and preserves
			// lone surrogates, which a UTF-8 round trip would replace.
			const copied = Buffer.from(value, "utf16le").toString("utf16le");
			return Object.freeze({ bytes, truncated: false, value: copied });
		}
	}
	let bytes = 0;
	let chunk = "";
	const chunks: string[] = [];
	for (const character of value) {
		const size = utf8CodePointBytes(character);
		if (bytes + size > maximumBytes) {
			return Object.freeze({ bytes, truncated: true, value: finishCopiedString(chunks, chunk) });
		}
		bytes += size;
		chunk += copiedCodePoint(character);
		if (chunk.length >= COPIED_STRING_CHUNK_CODE_UNITS) {
			chunks.push(chunk);
			chunk = "";
		}
	}
	return Object.freeze({ bytes, truncated: false, value: finishCopiedString(chunks, chunk) });
}

function finishCopiedString(chunks: string[], tail: string): string {
	if (tail.length > 0) chunks.push(tail);
	return chunks.join("");
}

function copiedCodePoint(character: string): string {
	return String.fromCodePoint(character.codePointAt(0) ?? 0xfffd);
}

function exceedsUtf8ByteLimit(value: string, maximumBytes: number): boolean {
	// Reject oversized UTF-16 lengths without scanning an unretained suffix.
	return value.length > maximumBytes || Buffer.byteLength(value, "utf8") > maximumBytes;
}

function utf8CodePointBytes(character: string): number {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined || codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}
