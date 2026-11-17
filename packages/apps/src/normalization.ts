import {
	MCP_APP_DEFAULT_TOOL_VISIBILITY,
	MCP_APP_RESOURCE_MIME_TYPE,
	MCP_APP_RESOURCE_URI_META_KEY,
} from "./constants.ts";
import { McpAppsValidationError, McpAppsValidationErrorCode } from "./mcp-apps.errors.ts";
import type {
	McpAppResourceCsp20260126,
	McpAppResourceMeta20260126,
	McpAppResourceMetadata20260126,
	McpAppResourcePermissions20260126,
	McpAppResourceUri,
	McpAppToolMetadata20260126,
	McpAppToolVisibility20260126,
	McpAppsClientCapability20260126,
} from "./spec-2026-01-26.ts";

const TOOL_UI_KEYS = new Set(["resourceUri", "visibility", "csp", "permissions"]);
const RESOURCE_UI_KEYS = new Set(["csp", "permissions", "domain", "prefersBorder"]);
const CSP_KEYS = new Set(["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]);
const PERMISSION_KEYS = new Set(["camera", "microphone", "geolocation", "clipboardWrite"]);
const CONNECT_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const WEB_SCHEMES = new Set(["http:", "https:"]);
const WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;

export interface NormalizeMcpAppToolMetadataOptions {
	/** Mirror the canonical URI to the deprecated flat key for older hosts. Defaults to `true`. */
	readonly includeDeprecatedResourceUri?: boolean;
}

export function isMcpAppResourceUri(value: unknown): value is McpAppResourceUri {
	return (
		typeof value === "string" &&
		value.startsWith("ui://") &&
		value.length > "ui://".length &&
		!WHITESPACE_OR_CONTROL.test(value)
	);
}

export function normalizeMcpAppResourceUri<const Value extends string>(
	value: Value,
): Value & McpAppResourceUri;
export function normalizeMcpAppResourceUri(value: unknown): McpAppResourceUri;
export function normalizeMcpAppResourceUri(value: unknown): McpAppResourceUri {
	if (!isMcpAppResourceUri(value)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidUri,
			"resource URI",
			`expected a non-empty URI beginning with exact "ui://", received ${describe(value)}`,
		);
	}
	return value;
}

/** Omission selects the stable default; an explicit value must match the stable MIME exactly. */
export function normalizeMcpAppResourceMimeType(
	value: unknown = MCP_APP_RESOURCE_MIME_TYPE,
): typeof MCP_APP_RESOURCE_MIME_TYPE {
	if (value !== MCP_APP_RESOURCE_MIME_TYPE) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidMimeType,
			"resource MIME type",
			`expected ${JSON.stringify(MCP_APP_RESOURCE_MIME_TYPE)}, received ${describe(value)}`,
		);
	}
	return MCP_APP_RESOURCE_MIME_TYPE;
}

/** Omission resolves to the stable `["model", "app"]` default; an explicit empty array stays empty. */
export function normalizeMcpAppToolVisibility(
	value: unknown = MCP_APP_DEFAULT_TOOL_VISIBILITY,
): readonly McpAppToolVisibility20260126[] {
	if (!Array.isArray(value)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidVisibility,
			"tool visibility",
			`expected an array containing only "model" and/or "app", received ${describe(value)}`,
		);
	}
	const normalized: McpAppToolVisibility20260126[] = [];
	for (const [index, entry] of value.entries()) {
		if (entry !== "model" && entry !== "app") {
			throw invalid(
				McpAppsValidationErrorCode.InvalidVisibility,
				`tool visibility[${index}]`,
				`expected "model" or "app", received ${describe(entry)}`,
			);
		}
		if (!normalized.includes(entry)) normalized.push(entry);
	}
	return Object.freeze(normalized);
}

export function normalizeMcpAppResourceCsp(value: unknown): McpAppResourceCsp20260126 {
	const input = plainRecord(value, McpAppsValidationErrorCode.InvalidCsp, "resource CSP");
	assertKnownKeys(input, CSP_KEYS, McpAppsValidationErrorCode.InvalidCsp, "resource CSP");
	const output: {
		connectDomains?: readonly string[];
		resourceDomains?: readonly string[];
		frameDomains?: readonly string[];
		baseUriDomains?: readonly string[];
	} = {};
	if (input.connectDomains !== undefined) {
		output.connectDomains = normalizeOrigins(
			input.connectDomains,
			CONNECT_SCHEMES,
			"resource CSP.connectDomains",
		);
	}
	if (input.resourceDomains !== undefined) {
		output.resourceDomains = normalizeOrigins(
			input.resourceDomains,
			WEB_SCHEMES,
			"resource CSP.resourceDomains",
		);
	}
	if (input.frameDomains !== undefined) {
		output.frameDomains = normalizeOrigins(
			input.frameDomains,
			WEB_SCHEMES,
			"resource CSP.frameDomains",
		);
	}
	if (input.baseUriDomains !== undefined) {
		output.baseUriDomains = normalizeOrigins(
			input.baseUriDomains,
			WEB_SCHEMES,
			"resource CSP.baseUriDomains",
		);
	}
	return Object.freeze(output);
}

export function normalizeMcpAppResourcePermissions(
	value: unknown,
): McpAppResourcePermissions20260126 {
	const input = plainRecord(
		value,
		McpAppsValidationErrorCode.InvalidPermissions,
		"resource permissions",
	);
	assertKnownKeys(
		input,
		PERMISSION_KEYS,
		McpAppsValidationErrorCode.InvalidPermissions,
		"resource permissions",
	);
	const output: Record<string, Readonly<Record<string, never>>> = {};
	for (const key of PERMISSION_KEYS) {
		const marker = input[key];
		if (marker === undefined) continue;
		const record = plainRecord(
			marker,
			McpAppsValidationErrorCode.InvalidPermissions,
			`resource permissions.${key}`,
		);
		if (Object.keys(record).length !== 0) {
			throw invalid(
				McpAppsValidationErrorCode.InvalidPermissions,
				`resource permissions.${key}`,
				"expected the stable empty-object permission marker",
			);
		}
		output[key] = Object.freeze({});
	}
	return Object.freeze(output);
}

export function normalizeMcpAppResourceMeta(value: unknown): McpAppResourceMeta20260126 {
	const input = plainRecord(value, McpAppsValidationErrorCode.InvalidMetadata, "resource _meta.ui");
	assertKnownKeys(
		input,
		RESOURCE_UI_KEYS,
		McpAppsValidationErrorCode.InvalidMetadata,
		"resource _meta.ui",
	);
	const output: {
		csp?: McpAppResourceCsp20260126;
		permissions?: McpAppResourcePermissions20260126;
		domain?: string;
		prefersBorder?: boolean;
	} = {};
	if (input.csp !== undefined) output.csp = normalizeMcpAppResourceCsp(input.csp);
	if (input.permissions !== undefined) {
		output.permissions = normalizeMcpAppResourcePermissions(input.permissions);
	}
	if (input.domain !== undefined) output.domain = normalizeDomain(input.domain);
	if (input.prefersBorder !== undefined) {
		if (typeof input.prefersBorder !== "boolean") {
			throw invalid(
				McpAppsValidationErrorCode.InvalidMetadata,
				"resource _meta.ui.prefersBorder",
				`expected a boolean, received ${describe(input.prefersBorder)}`,
			);
		}
		output.prefersBorder = input.prefersBorder;
	}
	return Object.freeze(output);
}

export function normalizeMcpAppToolMetadata(
	value: unknown,
	options: NormalizeMcpAppToolMetadataOptions = {},
): McpAppToolMetadata20260126 {
	const input = plainRecord(value, McpAppsValidationErrorCode.InvalidMetadata, "tool _meta");
	const hasNested = Object.hasOwn(input, "ui");
	const hasDeprecated = Object.hasOwn(input, MCP_APP_RESOURCE_URI_META_KEY);
	if (!hasNested && !hasDeprecated) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidMetadata,
			"tool _meta",
			`expected "ui" or deprecated "${MCP_APP_RESOURCE_URI_META_KEY}" metadata`,
		);
	}
	const uiInput = hasNested
		? plainRecord(input.ui, McpAppsValidationErrorCode.InvalidMetadata, "tool _meta.ui")
		: {};
	assertKnownKeys(
		uiInput,
		TOOL_UI_KEYS,
		McpAppsValidationErrorCode.InvalidMetadata,
		"tool _meta.ui",
	);
	if (uiInput.csp !== undefined || uiInput.permissions !== undefined) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidMetadata,
			"tool _meta.ui",
			"CSP and permissions belong on the referenced resource, not the tool",
		);
	}
	const nestedUri =
		uiInput.resourceUri === undefined ? undefined : normalizeMcpAppResourceUri(uiInput.resourceUri);
	const deprecatedValue = input[MCP_APP_RESOURCE_URI_META_KEY];
	const deprecatedUri =
		deprecatedValue === undefined ? undefined : normalizeMcpAppResourceUri(deprecatedValue);
	if (nestedUri !== undefined && deprecatedUri !== undefined && nestedUri !== deprecatedUri) {
		throw invalid(
			McpAppsValidationErrorCode.ConflictingResourceUri,
			"tool _meta",
			`nested resource URI ${JSON.stringify(nestedUri)} conflicts with deprecated URI ${JSON.stringify(deprecatedUri)}`,
		);
	}
	const resourceUri = nestedUri ?? deprecatedUri;
	const ui = Object.freeze({
		...(resourceUri === undefined ? {} : { resourceUri }),
		visibility: normalizeMcpAppToolVisibility(uiInput.visibility),
	});
	const output: McpAppToolMetadata20260126 = {
		...copyWithout(input, ["ui", MCP_APP_RESOURCE_URI_META_KEY]),
		ui,
		...((options.includeDeprecatedResourceUri ?? true) && resourceUri !== undefined
			? { [MCP_APP_RESOURCE_URI_META_KEY]: resourceUri }
			: {}),
	};
	return Object.freeze(output);
}

export function normalizeMcpAppResourceMetadata(value: unknown): McpAppResourceMetadata20260126 {
	const input = plainRecord(value, McpAppsValidationErrorCode.InvalidMetadata, "resource _meta");
	const output = copyWithout(input, ["ui"]);
	if (Object.hasOwn(input, "ui")) output.ui = normalizeMcpAppResourceMeta(input.ui);
	return Object.freeze(output);
}

/** Validates the required stable MIME list while preserving additive extension settings. */
export function normalizeMcpAppsClientCapability(value: unknown): McpAppsClientCapability20260126 {
	const input = plainRecord(value, McpAppsValidationErrorCode.InvalidMetadata, "client capability");
	if (
		!Array.isArray(input.mimeTypes) ||
		!input.mimeTypes.every((entry) => typeof entry === "string")
	) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidMetadata,
			"client capability.mimeTypes",
			"expected an array of MIME type strings",
		);
	}
	return Object.freeze({
		...copyWithout(input, ["mimeTypes"]),
		mimeTypes: Object.freeze([...new Set(input.mimeTypes)]),
	});
}

function normalizeOrigins(
	value: unknown,
	schemes: ReadonlySet<string>,
	path: string,
): readonly string[] {
	if (!Array.isArray(value)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidCsp,
			path,
			`expected an array of origins, received ${describe(value)}`,
		);
	}
	const output: string[] = [];
	for (const [index, entry] of value.entries()) {
		const origin = normalizeOrigin(entry, schemes, `${path}[${index}]`);
		if (!output.includes(origin)) output.push(origin);
	}
	return Object.freeze(output);
}

function normalizeOrigin(value: unknown, schemes: ReadonlySet<string>, path: string): string {
	if (typeof value !== "string" || value.length === 0 || WHITESPACE_OR_CONTROL.test(value)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidCsp,
			path,
			`expected an absolute origin without whitespace, received ${describe(value)}`,
		);
	}
	const wildcardMatch = /^(https?|wss?):\/\/\*\.(.+)$/iu.exec(value);
	const parseValue = wildcardMatch
		? `${wildcardMatch[1]}://mcp-app-wildcard.${wildcardMatch[2]}`
		: value;
	let parsed: URL;
	try {
		parsed = new URL(parseValue);
	} catch {
		throw invalid(
			McpAppsValidationErrorCode.InvalidCsp,
			path,
			`expected an absolute web origin, received ${JSON.stringify(value)}`,
		);
	}
	if (
		!schemes.has(parsed.protocol) ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.hostname === ""
	) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidCsp,
			path,
			`expected an allowed origin with no credentials, path, query, or fragment, received ${JSON.stringify(value)}`,
		);
	}
	if (!wildcardMatch) return parsed.origin;
	const wildcardPrefix = "mcp-app-wildcard.";
	if (!parsed.hostname.startsWith(wildcardPrefix)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidCsp,
			path,
			`invalid wildcard origin ${JSON.stringify(value)}`,
		);
	}
	const hostname = parsed.hostname.slice(wildcardPrefix.length);
	const port = parsed.port === "" ? "" : `:${parsed.port}`;
	return `${parsed.protocol}//*.${hostname}${port}`;
}

function normalizeDomain(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || WHITESPACE_OR_CONTROL.test(value)) {
		throw invalid(
			McpAppsValidationErrorCode.InvalidMetadata,
			"resource _meta.ui.domain",
			`expected a non-empty, control-free host-specific domain, received ${describe(value)}`,
		);
	}
	return value;
}

function plainRecord(
	value: unknown,
	code: McpAppsValidationErrorCode,
	path: string,
): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		throw invalid(code, path, `expected a plain object, received ${describe(value)}`);
	}
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
	input: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	code: McpAppsValidationErrorCode,
	path: string,
): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) throw invalid(code, `${path}.${key}`, "field is not in the stable spec");
	}
}

function copyWithout(
	input: Record<string, unknown>,
	omitted: readonly string[],
): Record<string, unknown> {
	const entries = Object.entries(input).filter(([key]) => !omitted.includes(key));
	return Object.fromEntries(entries);
}

function describe(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

function invalid(
	code: McpAppsValidationErrorCode,
	path: string,
	detail: string,
): McpAppsValidationError {
	return new McpAppsValidationError(code, path, detail);
}
