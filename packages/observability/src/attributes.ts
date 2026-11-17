import type { McpAttributes, McpOperationContext } from "@nest-mcp/core";

export type McpTelemetryAttributeValue = string | number | boolean;

export type McpTelemetryAttributes = Readonly<Record<string, McpTelemetryAttributeValue>>;

export type McpTelemetryAttributeSource = "standard" | "additional" | "selected";

export interface McpTelemetryAttributeCandidate<
	Context extends McpOperationContext = McpOperationContext,
> {
	readonly key: string;
	readonly value: unknown;
	readonly source: McpTelemetryAttributeSource;
	readonly context: Context;
}

export interface McpTelemetryProjectionOptions<
	Context extends McpOperationContext = McpOperationContext,
> {
	/** Maximum emitted attributes. Must be between 1 and the hard limit of 64. */
	readonly maxAttributes?: number;
	/** Maximum attribute-key length. Must be between 1 and the hard limit of 128. */
	readonly maxKeyLength?: number;
	/** Maximum string-value length. Must be between 1 and the hard limit of 1,024. */
	readonly maxStringLength?: number;
	/** Target is safe for named runtimes but can be disabled when it has excessive cardinality. */
	readonly includeTarget?: boolean;
	/**
	 * Explicit opt-in for application dimensions. The operation input, principal,
	 * request ID, session ID, and arbitrary context attributes are never read by default.
	 */
	readonly selectAttributes?: (context: Context) => McpAttributes;
	/**
	 * Sensitive-looking keys are dropped unless this hook explicitly allows them.
	 * Prefer returning a derived bucket or hash from `selectAttributes` instead.
	 */
	readonly allowSensitiveAttribute?: (
		candidate: McpTelemetryAttributeCandidate<Context>,
	) => boolean;
	/** Final opt-in redaction/normalization hook. Return undefined to drop an attribute. */
	readonly redactAttribute?: (
		candidate: McpTelemetryAttributeCandidate<Context>,
	) => McpTelemetryAttributeValue | undefined;
}

export const MCP_TELEMETRY_DEFAULT_LIMITS = Object.freeze({
	maxAttributes: 16,
	maxKeyLength: 64,
	maxStringLength: 128,
});

export const MCP_TELEMETRY_HARD_LIMITS = Object.freeze({
	maxAttributes: 64,
	maxKeyLength: 128,
	maxStringLength: 1_024,
});

/**
 * Projects a context into a small backend-compatible attribute set. Standard
 * dimensions are retained first, followed by call-site attributes and an
 * explicit user selector. Unsupported or sensitive values are dropped.
 */
export function projectMcpTelemetryAttributes<
	Context extends McpOperationContext = McpOperationContext,
>(
	context: Context,
	options: McpTelemetryProjectionOptions<Context> = {},
	additionalAttributes: McpAttributes = {},
): McpTelemetryAttributes {
	const limits = {
		maxAttributes: readLimit(
			options.maxAttributes,
			MCP_TELEMETRY_DEFAULT_LIMITS.maxAttributes,
			MCP_TELEMETRY_HARD_LIMITS.maxAttributes,
			"maxAttributes",
		),
		maxKeyLength: readLimit(
			options.maxKeyLength,
			MCP_TELEMETRY_DEFAULT_LIMITS.maxKeyLength,
			MCP_TELEMETRY_HARD_LIMITS.maxKeyLength,
			"maxKeyLength",
		),
		maxStringLength: readLimit(
			options.maxStringLength,
			MCP_TELEMETRY_DEFAULT_LIMITS.maxStringLength,
			MCP_TELEMETRY_HARD_LIMITS.maxStringLength,
			"maxStringLength",
		),
	};

	assertAttributeRecord(additionalAttributes, "additionalAttributes");
	const selectedAttributes = options.selectAttributes?.(context) ?? {};
	assertAttributeRecord(selectedAttributes, "selectAttributes result");

	const standardAttributes: McpAttributes = {
		"mcp.runtime.role": context.role,
		"mcp.operation.name": context.operation.name,
		"mcp.operation.kind": context.operation.kind,
		...(context.operation.capability === undefined
			? {}
			: { "mcp.operation.capability": context.operation.capability }),
		...(options.includeTarget === false || context.operation.target === undefined
			? {}
			: { "mcp.operation.target": context.operation.target }),
	};

	const projected: Record<string, McpTelemetryAttributeValue> = {};
	appendAttributes(projected, standardAttributes, "standard", context, options, limits);
	appendAttributes(projected, additionalAttributes, "additional", context, options, limits);
	appendAttributes(projected, selectedAttributes, "selected", context, options, limits);

	return Object.freeze(projected);
}

interface ResolvedLimits {
	readonly maxAttributes: number;
	readonly maxKeyLength: number;
	readonly maxStringLength: number;
}

function appendAttributes<Context extends McpOperationContext>(
	target: Record<string, McpTelemetryAttributeValue>,
	attributes: McpAttributes,
	source: McpTelemetryAttributeSource,
	context: Context,
	options: McpTelemetryProjectionOptions<Context>,
	limits: ResolvedLimits,
): void {
	for (const key of Object.keys(attributes).toSorted()) {
		if (Object.keys(target).length >= limits.maxAttributes) return;
		const normalizedKey = key.trim();
		if (normalizedKey.length === 0 || normalizedKey.length > limits.maxKeyLength) continue;
		if (Object.hasOwn(target, normalizedKey)) continue;

		const candidate = {
			key: normalizedKey,
			value: attributes[key],
			source,
			context,
		} satisfies McpTelemetryAttributeCandidate<Context>;

		if (isSensitiveKey(normalizedKey) && options.allowSensitiveAttribute?.(candidate) !== true) {
			continue;
		}

		const redacted =
			options.redactAttribute === undefined ? candidate.value : options.redactAttribute(candidate);
		const value = sanitizeValue(redacted, limits.maxStringLength);
		if (value === undefined) continue;
		target[normalizedKey] = value;
	}
}

function sanitizeValue(
	value: unknown,
	maxStringLength: number,
): McpTelemetryAttributeValue | undefined {
	if (typeof value === "string") return value.slice(0, maxStringLength);
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function isSensitiveKey(key: string): boolean {
	// Stable error classification is not an authorization code or credential.
	if (key === "error.code" || key === "mcp.error.code") return false;
	const segments = key
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1.$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const normalized = segments.join("");
	const sensitiveSegments = new Set([
		"auth",
		"authorization",
		"code",
		"cookie",
		"credential",
		"jwt",
		"key",
		"password",
		"pkce",
		"principal",
		"secret",
		"token",
		"verifier",
	]);
	return (
		segments.some((segment) => sensitiveSegments.has(segment)) ||
		normalized.includes("authorization") ||
		normalized.includes("authtoken") ||
		normalized.includes("bearertoken") ||
		normalized.includes("accesstoken") ||
		normalized.includes("refreshtoken") ||
		normalized.includes("idtoken") ||
		normalized.includes("apikey") ||
		normalized.includes("privatekey") ||
		normalized.includes("signingkey") ||
		normalized.includes("authorizationcode") ||
		normalized.includes("pkceverifier") ||
		normalized.includes("jwt") ||
		normalized.includes("secret") ||
		normalized.includes("clientsecret") ||
		normalized.includes("password") ||
		normalized.includes("credential") ||
		normalized.includes("cookie") ||
		normalized.includes("principal") ||
		normalized.includes("requestid") ||
		normalized.includes("sessionid")
	);
}

function readLimit(
	value: number | undefined,
	fallback: number,
	hardLimit: number,
	name: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1 || resolved > hardLimit) {
		throw new RangeError(`${name} must be an integer between 1 and ${String(hardLimit)}.`);
	}
	return resolved;
}

function assertAttributeRecord(value: unknown, name: string): asserts value is McpAttributes {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${name} must be a record.`);
	}
}
