import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type {
	McpGatewayDecodedResourceUri,
	McpGatewayResourceUriCodec,
} from "./mcp-gateway.types.ts";

const COMPONENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_SCHEME = "mcp-gateway";
const DEFAULT_AUTHORITY = "v1";
const DEFAULT_MAX_URI_LENGTH = 8_192;

export interface GatewayResourceUriCodecOptions {
	readonly scheme?: string;
	readonly authority?: string;
	readonly maxProjectedUriLength?: number;
}

/** Canonical reversible projection for concrete upstream resource URIs. */
export class GatewayResourceUriCodec implements McpGatewayResourceUriCodec {
	readonly scheme: string;
	readonly authority: string;
	readonly maxProjectedUriLength: number;

	constructor(options: GatewayResourceUriCodecOptions = {}) {
		this.scheme = validateScheme(options.scheme ?? DEFAULT_SCHEME);
		this.authority = validateAuthority(options.authority ?? DEFAULT_AUTHORITY);
		this.maxProjectedUriLength = positiveInteger(
			options.maxProjectedUriLength ?? DEFAULT_MAX_URI_LENGTH,
			"maxProjectedUriLength",
		);
	}

	encode(upstreamName: string, resourceUri: string): string {
		assertNonEmpty(upstreamName, "upstreamName");
		assertSafeAbsoluteUri(resourceUri, "resourceUri");
		const projectedUri = `${this.scheme}://${this.authority}/${encodeComponent(upstreamName)}/${encodeComponent(resourceUri)}`;
		if (projectedUri.length > this.maxProjectedUriLength) {
			throw new McpGatewayError(
				"INVALID_PROJECTED_URI",
				`Projected MCP gateway resource URI exceeds ${String(this.maxProjectedUriLength)} characters.`,
			);
		}
		return projectedUri;
	}

	decode(projectedUri: string): McpGatewayDecodedResourceUri {
		if (typeof projectedUri !== "string" || projectedUri.length > this.maxProjectedUriLength) {
			throw invalidUri();
		}
		let parsed: URL;
		try {
			parsed = new URL(projectedUri);
		} catch {
			throw invalidUri();
		}
		if (
			parsed.protocol !== `${this.scheme}:` ||
			parsed.hostname !== this.authority ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.port !== "" ||
			parsed.search !== "" ||
			parsed.hash !== "" ||
			parsed.href !== projectedUri
		) {
			throw invalidUri();
		}
		const parts = parsed.pathname.split("/");
		const upstreamPart = parts[1];
		const resourcePart = parts[2];
		if (
			parts.length !== 3 ||
			upstreamPart === undefined ||
			resourcePart === undefined ||
			!COMPONENT_PATTERN.test(upstreamPart) ||
			!COMPONENT_PATTERN.test(resourcePart)
		) {
			throw invalidUri();
		}

		const upstreamName = decodeComponent(upstreamPart);
		const resourceUri = decodeComponent(resourcePart);
		assertSafeAbsoluteUri(resourceUri, "decoded resource URI");
		if (this.encode(upstreamName, resourceUri) !== projectedUri) throw invalidUri();
		return Object.freeze({ upstreamName, resourceUri });
	}

	tryDecode(projectedUri: string): McpGatewayDecodedResourceUri | undefined {
		try {
			return this.decode(projectedUri);
		} catch (error) {
			if (error instanceof McpGatewayError && error.code === "INVALID_PROJECTED_URI") {
				return undefined;
			}
			throw error;
		}
	}
}

function encodeComponent(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeComponent(value: string): string {
	const decoded = Buffer.from(value, "base64url").toString("utf8");
	if (decoded.length === 0 || encodeComponent(decoded) !== value) throw invalidUri();
	return decoded;
}

function validateScheme(value: string): string {
	if (!/^[a-z][a-z0-9+.-]*$/.test(value)) {
		throw new TypeError("scheme must be a lowercase URI scheme.");
	}
	return value;
}

function validateAuthority(value: string): string {
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
		throw new TypeError("authority must be a canonical lowercase URI host.");
	}
	return value;
}

function assertSafeAbsoluteUri(value: string, field: string): void {
	assertNonEmpty(value, field);
	try {
		const parsed = new URL(value);
		if (parsed.protocol.length <= 1) throw new TypeError();
		if (parsed.username !== "" || parsed.password !== "") {
			throw new TypeError(`${field} must not contain URI userinfo credentials.`);
		}
	} catch {
		throw new TypeError(`${field} must be an absolute URI without URI userinfo credentials.`);
	}
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${field} must be a positive safe integer.`);
	}
	return value;
}

function invalidUri(): McpGatewayError {
	return new McpGatewayError(
		"INVALID_PROJECTED_URI",
		"Value is not a canonical projected MCP gateway resource URI.",
	);
}
