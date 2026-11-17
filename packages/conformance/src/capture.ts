import { types as nodeTypes } from "node:util";

import { captureLimitError, captureRejectedError } from "./errors.ts";
import { canonicalizeMcpConformanceValue } from "./fingerprint.ts";
import {
	resolveMcpConformanceCaptureLimits,
	type McpConformanceCaptureLimits,
	type ResolvedMcpConformanceCaptureLimits,
} from "./limits.ts";

export type McpConformanceCapturedValue =
	null | boolean | number | string | McpConformanceCapturedArray | McpConformanceCapturedObject;

export interface McpConformanceCapturedArray extends ReadonlyArray<McpConformanceCapturedValue> {
	readonly __mcpConformanceCapturedArray?: never;
}

export interface McpConformanceCapturedObject {
	readonly [key: string]: McpConformanceCapturedValue;
}

export type McpConformanceUndefinedPolicy = "json" | "reject";

export interface McpConformanceCaptureOptions {
	/**
	 * How to handle `undefined` below the captured root. `json` omits object
	 * properties and converts array entries to `null`; `reject` refuses either
	 * occurrence. Defaults to `json`.
	 */
	readonly undefinedPolicy?: McpConformanceUndefinedPolicy;
}

interface CaptureState {
	readonly ancestors: Set<object>;
	readonly limits: ResolvedMcpConformanceCaptureLimits;
	readonly undefinedPolicy: McpConformanceUndefinedPolicy;
	bytes: number;
	properties: number;
}

interface CaptureResult {
	readonly value: McpConformanceCapturedValue;
	readonly bytes: number;
}

/**
 * Copies an untrusted value into deep-frozen, null-prototype JSON data under
 * caller-supplied bounds.
 *
 * `canonicalizeMcpConformanceValue` only enforces fixed internal ceilings and
 * will happily walk a hostile shape on the way there. This capture refuses the
 * shape instead: proxies, accessor and non-enumerable properties, symbol keys,
 * sparse or subclassed arrays, exotic prototypes, cycles, and non-finite
 * numbers are rejected, and every string, property, array entry, nesting level,
 * and canonical byte is metered before the copy grows. By default, `undefined`
 * follows the canonicalizer's own JSON semantics: object properties holding it
 * are omitted and array entries holding it become `null`, so
 * `canonicalizeMcpConformanceValue(captureMcpConformanceValue(value, limits))`
 * always equals `canonicalizeMcpConformanceValue(value)`. Set
 * `options.undefinedPolicy` to `reject` when omission or coercion would hide an
 * invalid payload.
 */
export function captureMcpConformanceValue(
	value: unknown,
	limits: McpConformanceCaptureLimits,
	options?: McpConformanceCaptureOptions,
): unknown {
	return captureBounded(
		value,
		resolveMcpConformanceCaptureLimits(limits),
		resolveUndefinedPolicy(options),
	).value;
}

/**
 * Captures untrusted MCP tool arguments as a bounded, deep-frozen argument
 * record.
 *
 * Byte accounting is predictive: each captured node consumes exactly the
 * canonical JSON bytes it will later serialize to, so the budget is spent
 * before an oversized payload is ever materialized. The prediction is then
 * cross-checked against the exact output byte length of
 * `canonicalizeMcpConformanceValue`, and any disagreement rejects the
 * arguments rather than trusting a fence that failed to hold.
 */
export function captureMcpToolArguments(
	value: unknown,
	limits: McpConformanceCaptureLimits,
	options?: McpConformanceCaptureOptions,
): Readonly<Record<string, unknown>> {
	const captured = captureBounded(
		value,
		resolveMcpConformanceCaptureLimits(limits),
		resolveUndefinedPolicy(options),
	);
	if (!isCapturedObject(captured.value)) {
		throw captureRejectedError("tool arguments must be a plain object");
	}
	let canonical: string;
	try {
		canonical = canonicalizeMcpConformanceValue(captured.value);
	} catch (error) {
		throw captureRejectedError("the captured arguments are not canonicalizable", { cause: error });
	}
	if (Buffer.byteLength(canonical, "utf8") !== captured.bytes) {
		throw captureRejectedError("the captured arguments disagree with their byte accounting");
	}
	return captured.value;
}

export function captureBounded(
	value: unknown,
	limits: ResolvedMcpConformanceCaptureLimits,
	undefinedPolicy: McpConformanceUndefinedPolicy = "json",
): CaptureResult {
	const state: CaptureState = {
		ancestors: new Set<object>(),
		limits,
		undefinedPolicy,
		bytes: 0,
		properties: 0,
	};
	return { value: captureValue(value, state, 0), bytes: state.bytes };
}

export function isCapturedObject(value: unknown): value is McpConformanceCapturedObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureValue(
	value: unknown,
	state: CaptureState,
	depth: number,
): McpConformanceCapturedValue {
	if (depth > state.limits.maxDepth) throw captureLimitError("depth");
	if (value === undefined && state.undefinedPolicy === "reject") {
		throw captureRejectedError("undefined values are rejected by the capture policy");
	}
	if (value === null) {
		consumeBytes(state, 4);
		return null;
	}
	if (typeof value === "boolean") {
		consumeBytes(state, value ? 4 : 5);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw captureRejectedError("numbers must be finite");
		consumeBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"));
		return value;
	}
	if (typeof value === "string") return captureString(value, state);
	if (typeof value !== "object") {
		throw captureRejectedError(`a ${typeof value} value is not JSON data`);
	}
	if (nodeTypes.isProxy(value)) throw captureRejectedError("a proxy cannot be captured");
	if (state.ancestors.has(value)) throw captureRejectedError("cycles are not JSON data");
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) return captureArray(value, state, depth);
		return captureObject(value, state, depth);
	} finally {
		state.ancestors.delete(value);
	}
}

function captureObject(
	value: object,
	state: CaptureState,
	depth: number,
): McpConformanceCapturedObject {
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw captureRejectedError("only plain objects and arrays can be captured");
	}
	const keys: string[] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw captureRejectedError("symbol keys are not JSON data");
		keys.push(key);
	}
	reserveProperties(state, keys.length);
	const sortedKeys = keys.toSorted(compareCodeUnits);
	const entries: [key: string, value: unknown][] = [];
	for (const key of sortedKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) {
			throw captureRejectedError("accessor properties are not JSON data");
		}
		if (!descriptor.enumerable) {
			throw captureRejectedError("non-enumerable properties are not JSON data");
		}
		if (descriptor.value === undefined) {
			if (state.undefinedPolicy === "reject") {
				throw captureRejectedError("undefined values are rejected by the capture policy");
			}
			continue;
		}
		entries.push([key, descriptor.value]);
	}
	const output: Record<string, McpConformanceCapturedValue> = Object.create(null);
	consumeBytes(state, 1);
	for (const [index, [key, entry]] of entries.entries()) {
		if (index > 0) consumeBytes(state, 1);
		captureString(key, state);
		consumeBytes(state, 1);
		output[key] = captureValue(entry, state, depth + 1);
	}
	consumeBytes(state, 1);
	return Object.freeze(output);
}

function captureArray(
	value: readonly unknown[],
	state: CaptureState,
	depth: number,
): McpConformanceCapturedArray {
	if (Object.getPrototypeOf(value) !== Array.prototype) {
		throw captureRejectedError("subclassed arrays are not JSON data");
	}
	if (value.length > state.limits.maxItems) throw captureLimitError("array entry");
	if (Reflect.ownKeys(value).length !== value.length + 1) {
		throw captureRejectedError("sparse arrays and array properties are not JSON data");
	}
	reserveProperties(state, value.length);
	const output: McpConformanceCapturedValue[] = [];
	consumeBytes(state, 1);
	for (let index = 0; index < value.length; index += 1) {
		if (index > 0) consumeBytes(state, 1);
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor)) {
			throw captureRejectedError("accessor entries are not JSON data");
		}
		if (!descriptor.enumerable) {
			throw captureRejectedError("non-enumerable entries are not JSON data");
		}
		if (descriptor.value === undefined && state.undefinedPolicy === "reject") {
			throw captureRejectedError("undefined values are rejected by the capture policy");
		}
		output.push(
			descriptor.value === undefined
				? nullEntry(state)
				: captureValue(descriptor.value, state, depth + 1),
		);
	}
	consumeBytes(state, 1);
	return Object.freeze(output);
}

function nullEntry(state: CaptureState): null {
	consumeBytes(state, 4);
	return null;
}

/** Meters the escaped canonical width and the unescaped source width together. */
function captureString(value: string, state: CaptureState): string {
	let rawBytes = 0;
	consumeBytes(state, 1);
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (
			codeUnit === 0x22 ||
			codeUnit === 0x5c ||
			codeUnit === 0x08 ||
			codeUnit === 0x09 ||
			codeUnit === 0x0a ||
			codeUnit === 0x0c ||
			codeUnit === 0x0d
		) {
			rawBytes += 1;
			consumeBytes(state, 2);
		} else if (codeUnit < 0x20) {
			rawBytes += 1;
			consumeBytes(state, 6);
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				rawBytes += 4;
				consumeBytes(state, 4);
				index += 1;
			} else {
				rawBytes += 3;
				consumeBytes(state, 6);
			}
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			rawBytes += 3;
			consumeBytes(state, 6);
		} else if (codeUnit <= 0x7f) {
			rawBytes += 1;
			consumeBytes(state, 1);
		} else if (codeUnit <= 0x7ff) {
			rawBytes += 2;
			consumeBytes(state, 2);
		} else {
			rawBytes += 3;
			consumeBytes(state, 3);
		}
		if (rawBytes > state.limits.maxStringBytes) throw captureLimitError("string byte");
	}
	consumeBytes(state, 1);
	return value;
}

function reserveProperties(state: CaptureState, count: number): void {
	if (count > state.limits.maxProperties - state.properties) {
		throw captureLimitError("property");
	}
	state.properties += count;
}

function consumeBytes(state: CaptureState, count: number): void {
	if (count > state.limits.maxBytes - state.bytes) throw captureLimitError("byte");
	state.bytes += count;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function resolveUndefinedPolicy(
	options: McpConformanceCaptureOptions | undefined,
): McpConformanceUndefinedPolicy {
	const policy = options?.undefinedPolicy ?? "json";
	if (policy !== "json" && policy !== "reject") {
		throw new TypeError('options.undefinedPolicy must be either "json" or "reject".');
	}
	return policy;
}
