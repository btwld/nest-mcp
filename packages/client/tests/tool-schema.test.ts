import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { createMcpClientToolSchema, type McpClientToolInputSchema } from "../src/index.ts";

describe("createMcpClientToolSchema", () => {
	it("returns a Zod schema with an exact detached Standard Schema projection", async () => {
		const discovered = {
			type: "object",
			additionalProperties: false,
			properties: { query: { type: "string" } },
			required: ["query"],
		} satisfies McpClientToolInputSchema;
		const schema = createMcpClientToolSchema(discovered);
		const projected = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });

		expect(schema).toBeInstanceOf(z.ZodType);
		expect(projected).toEqual(discovered);
		expect(projected).not.toBe(discovered);
		expect(schema.toJSONSchema()).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			...discovered,
		});
		expect(() => schema["~standard"].jsonSchema.input({ target: "draft-07" })).toThrow(
			/Draft 2020-12/u,
		);
		expect(() => schema.toJSONSchema({ target: "draft-07" })).toThrow(/Draft 2020-12/u);
		expect(z.toJSONSchema(schema, { target: "draft-07" })).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
		});
		expect(z.toJSONSchema(schema.describe("query"), { target: "draft-07" })).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			description: "query",
		});
		expect(schema["~standard"].jsonSchema.input({})).toEqual(discovered);
		expect(schema.parse({ query: "registry" })).toEqual({ query: "registry" });
		expect(await schema["~standard"].validate({ query: "registry" })).toEqual({
			value: { query: "registry" },
		});

		for (const invalid of [{}, { query: 42 }, { query: "registry", extra: true }]) {
			expect(schema.safeParse(invalid)).toMatchObject({ success: false });
			const result = await schema["~standard"].validate(invalid);
			expect(result).toMatchObject({ issues: [{ message: expect.any(String) }] });
		}
	});

	it("keeps exposed Zod metadata immutable from the compiled validator", () => {
		const discovered = {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		} satisfies McpClientToolInputSchema;
		const schema = createMcpClientToolSchema(discovered);
		const metadata = schema.meta();
		const properties = metadata?.properties;

		if (typeof properties !== "object" || properties === null) {
			throw new TypeError("Expected projected JSON Schema metadata.");
		}

		expect(Object.isFrozen(properties)).toBe(true);
		expect(() => Object.assign(properties, { query: { type: "number" } })).toThrow(TypeError);
		expect(schema.safeParse({ query: 42 })).toMatchObject({ success: false });
		expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual(discovered);
	});

	it("retains constraints that Zod cannot reconstruct", () => {
		const schema = createMcpClientToolSchema({
			type: "object",
			properties: {
				tags: {
					type: "array",
					items: { type: "string" },
					uniqueItems: true,
				},
			},
			required: ["tags"],
		});

		expect(schema.safeParse({ tags: ["stable", "unique"] })).toMatchObject({ success: true });
		expect(schema.safeParse({ tags: ["duplicate", "duplicate"] })).toMatchObject({
			success: false,
		});
		expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({
			type: "object",
			properties: {
				tags: {
					type: "array",
					items: { type: "string" },
					uniqueItems: true,
				},
			},
			required: ["tags"],
		});
	});

	it("preserves official validation semantics and successful values", async () => {
		const schema = createMcpClientToolSchema({
			type: "object",
			additionalProperties: false,
			readOnly: true,
			properties: {
				reference: { type: "string", format: "uri-reference" },
				createdAt: { type: "string", format: "date-time" },
				count: { type: "number", default: "not-a-number" },
			},
			required: ["reference", "createdAt"],
		});
		const value = {
			reference: "relative/path",
			createdAt: "2020-01-01T00:00:00+05:30",
		};

		const parsed = schema.parse(value);
		expect(parsed).toBe(value);
		expect(parsed).toEqual(value);
		expect(Object.isFrozen(parsed)).toBe(false);
		expect(await schema["~standard"].validate(value)).toEqual({ value });
	});

	it("supports Draft 2020-12 constraints that Zod cannot reconstruct", () => {
		const schema = createMcpClientToolSchema({
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				value: { type: "string" },
			},
			dependentRequired: { enabled: ["value"] },
		});

		expect(schema.safeParse({ enabled: true, value: "present" })).toMatchObject({
			success: true,
		});
		expect(schema.safeParse({ enabled: true })).toMatchObject({ success: false });
	});

	it("isolates compiled schema identifiers between wrappers", () => {
		const discovered = {
			$id: "urn:artifact:test:shared-tool-schema",
			type: "object",
			properties: { query: { type: "string" } },
		} satisfies McpClientToolInputSchema;

		expect(() => createMcpClientToolSchema(discovered)).not.toThrow();
		expect(() => createMcpClientToolSchema(discovered)).not.toThrow();
	});

	it.each([
		{
			label: "invalid keyword value",
			schema: {
				type: "object" as const,
				properties: { query: { type: "not-a-json-schema-type" } },
			},
		},
		{
			label: "invalid regular expression",
			schema: {
				type: "object" as const,
				properties: { query: { type: "string", pattern: "[" } },
			},
		},
		{
			label: "unsupported dialect",
			schema: {
				$schema: "https://schemas.example.test/unsupported",
				type: "object" as const,
			},
		},
		{
			label: "supported older dialect",
			schema: {
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object" as const,
			},
		},
	])("fails closed for an $label schema", ({ schema }) => {
		expect(() => createMcpClientToolSchema(schema)).toThrow();
	});
});
