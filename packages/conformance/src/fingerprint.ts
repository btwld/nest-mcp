import { createHash } from "node:crypto";

const FINGERPRINT_PREFIX = "nest-mcp/conformance/fingerprint/v1";
const FINGERPRINT_DOMAIN = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const FINGERPRINT_TEXT = /^sha256:[A-Za-z0-9_-]{43}$/u;
const SHA256_BYTES = 32;
const MAX_FINGERPRINT_INPUT_BYTES = 8_388_608;
const MAX_FINGERPRINT_DEPTH = 128;
const MAX_FINGERPRINT_NODES = 100_000;
const MAX_FINGERPRINT_OBJECT_PROPERTIES = 50_000;
const STRING_CHUNK_CODE_UNITS = 4_096;

interface CanonicalWriter {
	readonly chunks: string[];
	readonly maximumBytes: number;
	bytes: number;
}

interface CanonicalState {
	readonly ancestors: Set<object>;
	readonly writer: CanonicalWriter;
	nodes: number;
}

export function fingerprintMcpConformanceValue(value: unknown, domain = "value"): string {
	assertMcpConformanceDomain(domain, "domain");
	const canonical = canonicalizeBounded(value);
	const digest = createHash("sha256")
		.update(FINGERPRINT_PREFIX)
		.update("\0")
		.update(domain)
		.update("\0")
		.update(canonical)
		.digest("base64url");
	return `sha256:${digest}`;
}

export function canonicalizeMcpConformanceValue(value: unknown): string {
	return canonicalizeBounded(value);
}

/**
 * Renders a `sha256:<base64url>` fingerprint as 64 lowercase hexadecimal
 * characters. Persistence layers that constrain a digest column with a fixed
 * hexadecimal CHECK can store the rendered form without hand-rolling transcoding.
 */
export function toMcpConformanceFingerprintHex(fingerprint: string): string {
	if (typeof fingerprint !== "string" || !FINGERPRINT_TEXT.test(fingerprint)) {
		throw new TypeError("fingerprint must be a sha256 conformance fingerprint.");
	}
	const encoded = fingerprint.slice("sha256:".length);
	const bytes = Buffer.from(encoded, "base64url");
	if (bytes.byteLength !== SHA256_BYTES || bytes.toString("base64url") !== encoded) {
		throw new TypeError("fingerprint must be a sha256 conformance fingerprint.");
	}
	return bytes.toString("hex");
}

/** Shared validation for caller-supplied fingerprint domains. */
export function assertMcpConformanceDomain(
	domain: unknown,
	name: string,
): asserts domain is string {
	if (typeof domain !== "string" || !FINGERPRINT_DOMAIN.test(domain)) {
		throw new TypeError(`${name} must be a bounded lowercase identifier.`);
	}
}

function canonicalizeBounded(value: unknown): string {
	const writer: CanonicalWriter = {
		chunks: [],
		maximumBytes: MAX_FINGERPRINT_INPUT_BYTES,
		bytes: 0,
	};
	canonicalize(value, false, { ancestors: new Set<object>(), writer, nodes: 0 }, 0);
	return writer.chunks.join("");
}

function canonicalize(
	value: unknown,
	arrayEntry: boolean,
	state: CanonicalState,
	depth: number,
): void {
	if (depth > MAX_FINGERPRINT_DEPTH) throw fingerprintStructureError();
	state.nodes += 1;
	if (state.nodes > MAX_FINGERPRINT_NODES) throw fingerprintStructureError();
	if (value === null) {
		append(state.writer, "null");
		return;
	}
	switch (typeof value) {
		case "string":
			appendJsonString(state.writer, value);
			return;
		case "boolean":
			append(state.writer, value ? "true" : "false");
			return;
		case "number":
			if (!Number.isFinite(value)) {
				throw new TypeError("Fingerprint values must contain only finite numbers.");
			}
			append(state.writer, JSON.stringify(value));
			return;
		case "undefined":
			if (arrayEntry) {
				append(state.writer, "null");
				return;
			}
			throw new TypeError("Fingerprint values must not contain undefined values.");
		case "bigint":
		case "function":
		case "symbol":
			throw new TypeError("Fingerprint values must be JSON-compatible.");
		case "object":
			canonicalizeObject(value, state, depth);
			return;
	}
	throw new TypeError("Fingerprint values must be JSON-compatible.");
}

function canonicalizeObject(value: object, state: CanonicalState, depth: number): void {
	if (state.ancestors.has(value))
		throw new TypeError("Fingerprint values must not contain cycles.");
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_FINGERPRINT_NODES - state.nodes) {
				throw fingerprintStructureError();
			}
			append(state.writer, "[");
			for (let index = 0; index < value.length; index += 1) {
				if (index > 0) append(state.writer, ",");
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor !== undefined && !("value" in descriptor)) {
					throw new TypeError("Fingerprint array entries must be data values.");
				}
				canonicalize(descriptor?.value, true, state, depth + 1);
			}
			append(state.writer, "]");
			return;
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Fingerprint values must contain only plain objects and arrays.");
		}
		const entries: [key: string, value: unknown][] = [];
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !descriptor.enumerable) continue;
			if (!("value" in descriptor)) {
				throw new TypeError("Fingerprint object properties must be data values.");
			}
			if (descriptor.value === undefined) continue;
			entries.push([key, descriptor.value]);
			if (entries.length > MAX_FINGERPRINT_OBJECT_PROPERTIES) {
				throw fingerprintStructureError();
			}
		}
		entries.sort(([left], [right]) => compareCodeUnits(left, right));
		append(state.writer, "{");
		for (const [index, [key, entry]] of entries.entries()) {
			if (index > 0) append(state.writer, ",");
			appendJsonString(state.writer, key);
			append(state.writer, ":");
			canonicalize(entry, false, state, depth + 1);
		}
		append(state.writer, "}");
	} finally {
		state.ancestors.delete(value);
	}
}

function appendJsonString(writer: CanonicalWriter, value: string): void {
	append(writer, '"');
	let piece = "";
	const flush = (): void => {
		if (piece.length === 0) return;
		append(writer, piece);
		piece = "";
	};
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === 0x22) piece += '\\"';
		else if (codeUnit === 0x5c) piece += "\\\\";
		else if (codeUnit === 0x08) piece += "\\b";
		else if (codeUnit === 0x09) piece += "\\t";
		else if (codeUnit === 0x0a) piece += "\\n";
		else if (codeUnit === 0x0c) piece += "\\f";
		else if (codeUnit === 0x0d) piece += "\\r";
		else if (codeUnit < 0x20) piece += unicodeEscape(codeUnit);
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				piece += String.fromCharCode(codeUnit, next);
				index += 1;
			} else piece += unicodeEscape(codeUnit);
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) piece += unicodeEscape(codeUnit);
		else piece += value[index];
		if (piece.length >= STRING_CHUNK_CODE_UNITS) flush();
	}
	flush();
	append(writer, '"');
}

function unicodeEscape(codeUnit: number): string {
	return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

function append(writer: CanonicalWriter, value: string): void {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > writer.maximumBytes - writer.bytes) throw fingerprintSizeError();
	writer.bytes += bytes;
	writer.chunks.push(value);
}

function fingerprintSizeError(): RangeError {
	return new RangeError("The fingerprint input exceeds the 8 MiB safety limit.");
}

function fingerprintStructureError(): RangeError {
	return new RangeError("The fingerprint input exceeds the structural safety limit.");
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
