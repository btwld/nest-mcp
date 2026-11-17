import { UriTemplate } from "@modelcontextprotocol/server";
import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type {
	McpGatewayDecodedResourceTemplateUri,
	McpGatewayResourceTemplateUriCodec,
} from "./mcp-gateway.types.ts";

const DEFAULT_SCHEME = "mcp-gateway-template";
const DEFAULT_AUTHORITY = "v1";
const DEFAULT_MAX_URI_LENGTH = 8_192;
const DEFAULT_MAX_VARIABLES = 128;
const COMPONENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const VARIABLE_PATTERN = /^[A-Za-z0-9_.%]+$/;
const TEMPLATE_EXPRESSION_PATTERN = /\{([^{}]+)\}/g;

export interface GatewayResourceTemplateUriCodecOptions {
	readonly scheme?: string;
	readonly authority?: string;
	readonly maxProjectedUriLength?: number;
	readonly maxVariables?: number;
}

/**
 * Reversible URI-template namespace. The upstream template is base64url encoded
 * while its variables are projected as required path expressions.
 */
export class GatewayResourceTemplateUriCodec implements McpGatewayResourceTemplateUriCodec {
	readonly scheme: string;
	readonly authority: string;
	readonly maxProjectedUriLength: number;
	readonly maxVariables: number;

	constructor(options: GatewayResourceTemplateUriCodecOptions = {}) {
		this.scheme = validateScheme(options.scheme ?? DEFAULT_SCHEME);
		this.authority = validateAuthority(options.authority ?? DEFAULT_AUTHORITY);
		this.maxProjectedUriLength = positiveInteger(
			options.maxProjectedUriLength ?? DEFAULT_MAX_URI_LENGTH,
			"maxProjectedUriLength",
		);
		this.maxVariables = positiveInteger(
			options.maxVariables ?? DEFAULT_MAX_VARIABLES,
			"maxVariables",
		);
	}

	encode(upstreamName: string, resourceTemplate: string): string {
		assertNonEmpty(upstreamName, "upstreamName");
		const variables = validateResourceTemplate(resourceTemplate, this.maxVariables);
		const suffix = variables.map((variable) => `{${variable}}`).join("/");
		const projected = `${this.scheme}://${this.authority}/${encodeComponent(upstreamName)}/${encodeComponent(resourceTemplate)}/values/${suffix}`;
		if (projected.length > this.maxProjectedUriLength) {
			throw new McpGatewayError(
				"INVALID_PROJECTED_TEMPLATE_URI",
				`Projected MCP gateway resource-template URI exceeds ${String(this.maxProjectedUriLength)} characters.`,
			);
		}
		return projected;
	}

	decode(projectedTemplateUri: string): McpGatewayDecodedResourceTemplateUri {
		if (
			typeof projectedTemplateUri !== "string" ||
			projectedTemplateUri.length > this.maxProjectedUriLength
		) {
			throw invalidTemplateUri();
		}
		const prefix = `${this.scheme}://${this.authority}/`;
		if (!projectedTemplateUri.startsWith(prefix)) throw invalidTemplateUri();
		const parts = projectedTemplateUri.slice(prefix.length).split("/");
		const upstreamPart = parts[0];
		const templatePart = parts[1];
		if (
			parts.length < 4 ||
			upstreamPart === undefined ||
			templatePart === undefined ||
			parts[2] !== "values" ||
			!COMPONENT_PATTERN.test(upstreamPart) ||
			!COMPONENT_PATTERN.test(templatePart)
		) {
			throw invalidTemplateUri();
		}
		for (const expression of parts.slice(3)) {
			if (!/^\{[A-Za-z0-9_.%]+\}$/.test(expression)) throw invalidTemplateUri();
		}
		const upstreamName = decodeComponent(upstreamPart);
		const resourceTemplate = decodeComponent(templatePart);
		if (this.encode(upstreamName, resourceTemplate) !== projectedTemplateUri) {
			throw invalidTemplateUri();
		}
		return Object.freeze({ upstreamName, resourceTemplate });
	}

	tryDecode(projectedTemplateUri: string): McpGatewayDecodedResourceTemplateUri | undefined {
		try {
			return this.decode(projectedTemplateUri);
		} catch (error) {
			if (error instanceof McpGatewayError && error.code === "INVALID_PROJECTED_TEMPLATE_URI") {
				return undefined;
			}
			throw error;
		}
	}
}

function validateResourceTemplate(
	resourceTemplate: string,
	maxVariables: number,
): readonly string[] {
	assertNonEmpty(resourceTemplate, "resourceTemplate");
	let template: UriTemplate;
	try {
		template = new UriTemplate(resourceTemplate);
	} catch (cause) {
		throw new TypeError("resourceTemplate must be a valid URI template.", { cause });
	}
	const variables = [...new Set(template.variableNames)];
	if (variables.length === 0) {
		throw new TypeError("resourceTemplate must contain at least one variable.");
	}
	for (const match of resourceTemplate.matchAll(TEMPLATE_EXPRESSION_PATTERN)) {
		const expression = match[1];
		if (
			expression === undefined ||
			expression.includes(",") ||
			expression.includes("*") ||
			expression.includes(":")
		) {
			throw new TypeError(
				"resourceTemplate expressions must contain one scalar variable; lists, explode modifiers, prefixes, and multi-variable expressions are not supported by the projected route.",
			);
		}
	}
	if (variables.length > maxVariables) {
		throw new McpGatewayError(
			"INVALID_PROJECTED_TEMPLATE_URI",
			`Resource template exceeds the ${String(maxVariables)} variable limit.`,
		);
	}
	for (const variable of variables) {
		if (!VARIABLE_PATTERN.test(variable)) {
			throw new TypeError(`Resource-template variable "${variable}" is not canonical.`);
		}
	}
	const expanded = template.expand(
		Object.fromEntries(variables.map((variable) => [variable, "x"])),
	);
	try {
		const parsed = new URL(expanded);
		if (parsed.username !== "" || parsed.password !== "") throw new TypeError();
	} catch (cause) {
		throw new TypeError(
			"resourceTemplate must expand to an absolute URI without URI userinfo credentials.",
			{ cause },
		);
	}
	return Object.freeze(variables);
}

function encodeComponent(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeComponent(value: string): string {
	const decoded = Buffer.from(value, "base64url").toString("utf8");
	if (decoded.length === 0 || encodeComponent(decoded) !== value) throw invalidTemplateUri();
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

function invalidTemplateUri(): McpGatewayError {
	return new McpGatewayError(
		"INVALID_PROJECTED_TEMPLATE_URI",
		"Value is not a canonical projected MCP gateway resource-template URI.",
	);
}
