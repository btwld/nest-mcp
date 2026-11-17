import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type { McpGatewayDecodedName, McpGatewayNameCodec } from "./mcp-gateway.types.ts";

const DEFAULT_PREFIX = "gw1";
const MAX_PROJECTED_NAME_LENGTH = 128;
const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const COMPONENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Reversible, collision-free namespace encoding for aggregate gateway tools.
 *
 * Components are independently UTF-8/base64url encoded and separated with a
 * character outside the base64url alphabet. The canonical re-encoding check
 * rejects permissive or ambiguous base64 spellings.
 */
export class GatewayNameCodec implements McpGatewayNameCodec {
	readonly prefix: string;

	constructor(prefix = DEFAULT_PREFIX) {
		if (!PREFIX_PATTERN.test(prefix)) {
			throw new TypeError(
				"Gateway name prefix must start with a letter and contain only letters, digits, _ or -.",
			);
		}
		this.prefix = prefix;
	}

	encode(upstreamName: string, toolName: string): string {
		assertComponent(upstreamName, "upstreamName");
		assertComponent(toolName, "toolName");
		const projectedName = `${this.prefix}.${encodeComponent(upstreamName)}.${encodeComponent(toolName)}`;
		if (projectedName.length > MAX_PROJECTED_NAME_LENGTH) {
			throw new McpGatewayError(
				"INVALID_PROJECTED_NAME",
				`Projected MCP gateway name exceeds ${String(MAX_PROJECTED_NAME_LENGTH)} characters. Use shorter upstream and capability names or provide a bounded custom codec.`,
			);
		}
		return projectedName;
	}

	decode(projectedName: string): McpGatewayDecodedName {
		if (typeof projectedName !== "string") {
			throw invalidName(String(projectedName));
		}
		const parts = projectedName.split(".");
		if (parts.length !== 3 || parts[0] !== this.prefix) {
			throw invalidName(projectedName);
		}
		const upstreamPart = parts[1];
		const toolPart = parts[2];
		if (
			upstreamPart === undefined ||
			toolPart === undefined ||
			!COMPONENT_PATTERN.test(upstreamPart) ||
			!COMPONENT_PATTERN.test(toolPart)
		) {
			throw invalidName(projectedName);
		}

		const upstreamName = decodeComponent(upstreamPart, projectedName);
		const toolName = decodeComponent(toolPart, projectedName);
		if (this.encode(upstreamName, toolName) !== projectedName) {
			throw invalidName(projectedName);
		}
		return Object.freeze({ upstreamName, toolName });
	}

	tryDecode(projectedName: string): McpGatewayDecodedName | undefined {
		try {
			return this.decode(projectedName);
		} catch (error) {
			if (error instanceof McpGatewayError && error.code === "INVALID_PROJECTED_NAME") {
				return undefined;
			}
			throw error;
		}
	}
}

function encodeComponent(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeComponent(value: string, projectedName: string): string {
	const decoded = Buffer.from(value, "base64url").toString("utf8");
	if (decoded.length === 0 || encodeComponent(decoded) !== value) {
		throw invalidName(projectedName);
	}
	return decoded;
}

function assertComponent(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}

function invalidName(projectedName: string): McpGatewayError {
	return new McpGatewayError(
		"INVALID_PROJECTED_NAME",
		`"${projectedName}" is not a canonical projected MCP gateway name.`,
	);
}
