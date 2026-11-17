import { captureMcpConformanceValue } from "@nest-mcp/conformance";

/** Optional stricter storage bounds; they cannot widen the protocol's fixed ceilings. */
export interface McpClientOAuthSnapshotOptions {
	readonly maxBytes?: number;
	readonly maxUrlLength?: number;
}

/** Never retains the decoded value, a validation cause, URLs, or secret material. */
export class McpClientOAuthSnapshotError extends Error {
	readonly code = "MCP_CLIENT_OAUTH_SNAPSHOT_INVALID" as const;
	constructor() {
		super("The MCP OAuth snapshot is invalid or exceeds its bounds.");
		this.name = "McpClientOAuthSnapshotError";
	}
}

export function parseOAuthSnapshot<Value>(
	value: unknown,
	options: McpClientOAuthSnapshotOptions,
	parse: (record: Readonly<Record<string, unknown>>, maxUrlLength: number) => Value,
): Value {
	try {
		const maxBytes = bound(options.maxBytes, 2 * 1_024 * 1_024);
		const maxUrlLength = bound(options.maxUrlLength, 4_096);
		const captured = captureMcpConformanceValue(
			value,
			{
				maxBytes,
				maxDepth: 8,
				maxItems: 8_192,
				maxProperties: 4_096,
				maxStringBytes: 65_536,
			},
			{ undefinedPolicy: "reject" },
		);
		return parse(oauthSnapshotRecord(captured), maxUrlLength);
	} catch {
		throw new McpClientOAuthSnapshotError();
	}
}

export function oauthSnapshotRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new McpClientOAuthSnapshotError();
	}
	return value as Readonly<Record<string, unknown>>;
}

export function assertOAuthSnapshotKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new McpClientOAuthSnapshotError();
}

export function oauthSnapshotString(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new McpClientOAuthSnapshotError();
	}
	return value;
}

export function oauthSnapshotStrings(value: unknown, maximum: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new McpClientOAuthSnapshotError();
	const entries: readonly unknown[] = value;
	if (!entries.every((entry): entry is string => typeof entry === "string")) {
		throw new McpClientOAuthSnapshotError();
	}
	return entries;
}

export function oauthSnapshotBoolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new McpClientOAuthSnapshotError();
	return value;
}

function bound(value: number | undefined, maximum: number): number {
	const result = value ?? maximum;
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
		throw new McpClientOAuthSnapshotError();
	}
	return result;
}
