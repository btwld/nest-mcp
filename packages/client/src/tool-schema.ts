import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { z } from "zod/v4";

import type { McpClientToolInputSchema, McpClientToolOutputSchema } from "./types.ts";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_2020_12_URIS = new Set([
	JSON_SCHEMA_2020_12,
	"http://json-schema.org/draft/2020-12/schema",
]);

export interface McpClientToolSchemaIssue {
	readonly message: string;
}

export type McpClientToolSchemaResult =
	{ readonly value: unknown } | { readonly issues: readonly McpClientToolSchemaIssue[] };

/** Standard Schema compatibility retained by the Zod tool schema. */
export interface McpClientToolStandardSchema {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => Promise<McpClientToolSchemaResult>;
		readonly jsonSchema: {
			readonly input: (options: unknown) => Record<string, unknown>;
			readonly output: (options: unknown) => Record<string, unknown>;
		};
	};
}

/** Runtime Zod view of a dynamically discovered MCP tool JSON Schema. */
export type McpClientToolSchema = McpClientToolStandardSchema & z.ZodType;

/**
 * Converts a discovered MCP tool JSON Schema into a Zod v4 schema.
 *
 * Zod v4 schemas also implement Standard Schema and Standard JSON Schema, so
 * the returned schema can be passed directly to either kind of consumer. The
 * official MCP validator remains the exact predicate because a discovered
 * Draft 2020-12 schema can contain constraints that Zod cannot reconstruct.
 * Invalid or unsupported schemas fail synchronously during construction.
 */
export function createMcpClientToolSchema(
	schema: McpClientToolInputSchema | McpClientToolOutputSchema,
): McpClientToolSchema {
	const jsonSchema = Object.fromEntries(Object.entries(structuredClone(schema)));
	assertDraft202012(jsonSchema);
	deepFreezeJson(jsonSchema);

	const validatorSchema: JsonSchemaType = structuredClone(jsonSchema);
	const validate = new AjvJsonSchemaValidator().getValidator<unknown>(validatorSchema);
	const zodMetadata = structuredClone(jsonSchema);
	zodMetadata.$schema = JSON_SCHEMA_2020_12;
	deepFreezeJson(zodMetadata);
	const zodSchema = z
		.unknown()
		.superRefine((value, context) => {
			const result = validate(value);
			if (!result.valid) {
				context.addIssue({ code: "custom", message: result.errorMessage });
			}
		})
		.meta(zodMetadata);
	const validateWithZod = zodSchema["~standard"].validate;
	const toJsonSchemaWithZod = zodSchema.toJSONSchema.bind(zodSchema);
	const projectJsonSchema = (options: unknown): Record<string, unknown> => {
		assertDraft202012Target(readTarget(options));

		return structuredClone(jsonSchema);
	};

	// Preserve the detached remote definition for Standard JSON Schema consumers.
	// Zod metadata keeps native projections on the same immutable 2020-12 dialect.
	Object.defineProperties(zodSchema["~standard"], {
		validate: {
			configurable: false,
			enumerable: true,
			writable: false,
			async value(value: unknown): Promise<McpClientToolSchemaResult> {
				return await validateWithZod(value);
			},
		},
		jsonSchema: {
			configurable: false,
			enumerable: true,
			writable: false,
			value: Object.freeze({
				input: projectJsonSchema,
				output: projectJsonSchema,
			}),
		},
	});
	Object.defineProperty(zodSchema, "toJSONSchema", {
		configurable: false,
		enumerable: true,
		writable: false,
		value(parameters?: Parameters<z.ZodType["toJSONSchema"]>[0]) {
			assertDraft202012Target(parameters?.target);
			return toJsonSchemaWithZod({ ...parameters, target: "draft-2020-12" });
		},
	});

	// The runtime overrides above retain the legacy Promise-only Standard
	// validation surface in addition to the concrete Zod API.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return zodSchema as McpClientToolSchema;
}

function assertDraft202012(schema: Readonly<Record<string, unknown>>): void {
	if (!("$schema" in schema)) {
		return;
	}

	const dialect = schema.$schema;
	if (typeof dialect === "string" && JSON_SCHEMA_2020_12_URIS.has(dialect.replace(/#$/u, ""))) {
		return;
	}

	throw new TypeError(
		"createMcpClientToolSchema supports JSON Schema Draft 2020-12 declarations only.",
	);
}

function assertDraft202012Target(target: unknown): void {
	if (target === undefined || target === "draft-2020-12") {
		return;
	}

	throw new TypeError(
		"MCP tool schemas use JSON Schema Draft 2020-12 and cannot be projected to another target.",
	);
}

function readTarget(options: unknown): unknown {
	return isJsonObject(options) ? options.target : undefined;
}

function deepFreezeJson(value: unknown, seen = new WeakSet<object>()): void {
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return;
		}

		seen.add(value);
		const items: readonly unknown[] = value;
		for (const item of items) {
			deepFreezeJson(item, seen);
		}
		Object.freeze(value);
		return;
	}

	if (!isJsonObject(value) || seen.has(value)) {
		return;
	}

	seen.add(value);
	for (const nested of Object.values(value)) {
		deepFreezeJson(nested, seen);
	}
	Object.freeze(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
