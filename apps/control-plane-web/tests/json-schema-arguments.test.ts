import { describe, expect, it } from "vitest";

import {
  RAW_ARGUMENTS_ERROR_PATH,
  ROOT_ARGUMENTS_ERROR_PATH,
  MAX_ARGUMENT_JSON_BYTES,
  analyzeArgumentSchema,
  argumentIncludedName,
  argumentModeName,
  argumentPath,
  argumentRawName,
  argumentValueName,
  createDefaultArguments,
  parseJsonSchemaArguments,
  type ArgumentSchemaNode,
} from "../lib/json-schema-arguments";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["query", "limit", "options"],
  properties: {
    query: {
      type: "string",
      description: "Search expression",
      minLength: 2,
      maxLength: 80,
    },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    exact: { type: "boolean", default: false },
    tags: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    options: {
      type: "object",
      required: ["strategy"],
      properties: {
        strategy: { type: "string", enum: ["fast", "thorough"] },
        threshold: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  },
} as const;

const zohoCriteriaSchema = {
  type: "object",
  required: ["query_params", "path_variables"],
  properties: {
    path_variables: {
      type: "object",
      required: ["portal_id"],
      properties: {
        portal_id: { type: "string" },
      },
    },
    query_params: {
      type: "object",
      required: ["page", "per_page"],
      properties: {
        page: { type: "integer" },
        per_page: { type: "integer" },
        filter: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            criteria: {
              type: "array",
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criteria_condition: { type: "string" },
                    value: { type: "array", items: { type: "string" } },
                  },
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        api_name: { type: "string" },
                        cfid: { type: "string" },
                        field_name: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

function structuredData(): FormData {
  const data = new FormData();
  data.set(argumentModeName(), "fields");
  return data;
}

describe("analyzeArgumentSchema", () => {
  it("escapes JSON Pointer tokens used by generated field paths", () => {
    expect(argumentPath(["options", "a/b", "til~de"])).toBe("/options/a~1b/til~0de");
  });

  it("models supported nested object, scalar, enum, and array inputs", () => {
    const analysis = analyzeArgumentSchema(schema);

    expect(analysis.supported).toBe(true);
    if (!analysis.supported) return;
    expect(analysis.root.properties.map((property) => property.node.kind)).toEqual([
      "string",
      "integer",
      "boolean",
      "array",
      "object",
    ]);
    expect(analysis.root.properties[4]?.node).toMatchObject({
      path: "/options",
      required: true,
    });
  });

  it("falls back for an ambiguous root while keeping a complex child local", () => {
    expect(analyzeArgumentSchema({ type: ["object", "null"] })).toEqual(
      expect.objectContaining({ supported: false }),
    );
    const analysis = analyzeArgumentSchema({
      type: "object",
      properties: { query: { oneOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(analysis.supported).toBe(true);
    if (!analysis.supported) return;
    expect(analysis.root.properties[0]?.node).toMatchObject({
      kind: "json",
      path: "/query",
      fallbackReason: expect.stringContaining("oneOf"),
    });
  });

  it("keeps the Zoho form available when an array item uses anyOf", () => {
    const analysis = analyzeArgumentSchema(zohoCriteriaSchema);

    expect(analysis.supported).toBe(true);
    if (!analysis.supported) return;
    const queryParams = analysis.root.properties.find(
      (property) => property.name === "query_params",
    )?.node;
    expect(queryParams?.kind).toBe("object");
    if (queryParams?.kind !== "object") return;
    const filter = queryParams.properties.find((property) => property.name === "filter")?.node;
    expect(filter?.kind).toBe("object");
    if (filter?.kind !== "object") return;
    const criteria = filter.properties.find((property) => property.name === "criteria")?.node;
    expect(criteria?.kind).toBe("array");
    if (criteria?.kind !== "array" || criteria.items.kind !== "array") return;
    expect(criteria.items.items).toMatchObject({
      kind: "json",
      expectedType: "object",
      path: "/query_params/filter/criteria/*/*",
      fallbackReason: expect.stringContaining("anyOf"),
    });
  });

  it("degrades a child when its schema exceeds the supported nesting depth", () => {
    let nested: unknown = { type: "string" };
    for (let level = 0; level < 20; level += 1) {
      nested = { type: "object", properties: { child: nested } };
    }

    const analysis = analyzeArgumentSchema(nested);
    expect(analysis.supported).toBe(true);
    if (!analysis.supported) return;

    let node: ArgumentSchemaNode = analysis.root;
    let depth = 0;
    while (node.kind === "object" && node.properties.length > 0) {
      node = node.properties[0]!.node;
      depth += 1;
    }

    expect(node.kind).toBe("json");
    if (node.kind !== "json") return;
    expect(node.fallbackReason).toContain("nesting depth of 16");
    expect(depth).toBeLessThanOrEqual(17);
  });

  it("degrades a circular child schema instead of recursing", () => {
    const circular: {
      properties: Record<string, unknown>;
      type: "object";
    } = { type: "object", properties: {} };
    circular.properties["self"] = circular;

    const analysis = analyzeArgumentSchema(circular);
    expect(analysis.supported).toBe(true);
    if (!analysis.supported) return;
    expect(analysis.root.properties[0]?.node).toMatchObject({
      kind: "json",
      fallbackReason: expect.stringContaining("circular schema reference"),
    });
  });

  it("collects nested defaults without inventing required values", () => {
    expect(createDefaultArguments(schema)).toEqual({ limit: 5, exact: false });
    expect(
      createDefaultArguments({
        type: "object",
        properties: {
          configuration: {
            type: "object",
            oneOf: [{ type: "object", properties: { mode: { type: "string" } } }],
            default: { mode: "safe" },
          },
        },
      }),
    ).toEqual({ configuration: { mode: "safe" } });
    expect(createDefaultArguments({ type: "string" })).toEqual({});
  });
});

describe("parseJsonSchemaArguments", () => {
  it("coerces structured form values without losing false or nested values", () => {
    const data = structuredData();
    data.set(argumentValueName("/query"), "react docs");
    data.set(argumentValueName("/limit"), "7");
    data.set(argumentIncludedName("/exact"), "true");
    data.set(argumentValueName("/exact"), "false");
    data.set(argumentIncludedName("/tags"), "true");
    data.set(argumentValueName("/tags"), '["ui", "mcp"]');
    data.set(argumentValueName("/options/strategy"), "fast");
    data.set(argumentIncludedName("/options/threshold"), "true");
    data.set(argumentValueName("/options/threshold"), "0.75");

    expect(parseJsonSchemaArguments(schema, data)).toEqual({
      success: true,
      mode: "fields",
      data: {
        query: "react docs",
        limit: 7,
        exact: false,
        tags: ["ui", "mcp"],
        options: { strategy: "fast", threshold: 0.75 },
      },
    });
  });

  it("omits optional fields unless their include control is selected", () => {
    const data = structuredData();
    data.set(argumentValueName("/query"), "mcp");
    data.set(argumentValueName("/limit"), "5");
    data.set(argumentValueName("/exact"), "true");
    data.set(argumentValueName("/tags"), '["ignored"]');
    data.set(argumentValueName("/options/strategy"), "thorough");

    expect(parseJsonSchemaArguments(schema, data)).toEqual({
      success: true,
      mode: "fields",
      data: { query: "mcp", limit: 5, options: { strategy: "thorough" } },
    });
  });

  it("returns errors keyed by JSON Pointer field paths", () => {
    const data = structuredData();
    data.set(argumentValueName("/query"), "x");
    data.set(argumentValueName("/limit"), "2.5");
    data.set(argumentValueName("/options/strategy"), "unknown");
    data.set(argumentIncludedName("/tags"), "true");
    data.set(argumentValueName("/tags"), '[""]');

    expect(parseJsonSchemaArguments(schema, data)).toEqual({
      success: false,
      mode: "fields",
      errors: expect.objectContaining({
        "/query": expect.stringContaining("at least 2"),
        "/limit": "Enter a whole number.",
        "/options/strategy": "Choose one of the advertised values.",
        "/tags": expect.stringContaining("/tags/0"),
      }),
    });
  });

  it("preserves Zoho's two-dimensional criteria JSON while parsing sibling fields", () => {
    const data = structuredData();
    data.set(argumentValueName("/path_variables/portal_id"), "123456");
    data.set(argumentValueName("/query_params/page"), "1");
    data.set(argumentValueName("/query_params/per_page"), "20");
    data.set(argumentIncludedName("/query_params/filter"), "true");
    data.set(argumentIncludedName("/query_params/filter/pattern"), "true");
    data.set(argumentValueName("/query_params/filter/pattern"), "1");
    data.set(argumentIncludedName("/query_params/filter/criteria"), "true");
    data.set(
      argumentValueName("/query_params/filter/criteria"),
      JSON.stringify([
        [
          {
            criteria_condition: "equals",
            value: ["open"],
            cfid: "456",
          },
        ],
      ]),
    );

    expect(parseJsonSchemaArguments(zohoCriteriaSchema, data)).toEqual({
      success: true,
      mode: "fields",
      data: {
        path_variables: { portal_id: "123456" },
        query_params: {
          page: 1,
          per_page: 20,
          filter: {
            pattern: "1",
            criteria: [
              [
                {
                  criteria_condition: "equals",
                  value: ["open"],
                  cfid: "456",
                },
              ],
            ],
          },
        },
      },
    });
  });

  it("keeps the declared array shape around a complex item schema", () => {
    const data = structuredData();
    data.set(argumentValueName("/path_variables/portal_id"), "123456");
    data.set(argumentValueName("/query_params/page"), "1");
    data.set(argumentValueName("/query_params/per_page"), "20");
    data.set(argumentIncludedName("/query_params/filter"), "true");
    data.set(argumentIncludedName("/query_params/filter/criteria"), "true");
    data.set(
      argumentValueName("/query_params/filter/criteria"),
      JSON.stringify([{ criteria_condition: "equals" }]),
    );

    expect(parseJsonSchemaArguments(zohoCriteriaSchema, data)).toEqual({
      success: false,
      mode: "fields",
      errors: {
        "/query_params/filter/criteria": expect.stringContaining("/query_params/filter/criteria/0"),
      },
    });
  });

  it("parses a field-local complex schema as typed JSON", () => {
    const complex = {
      type: "object",
      required: ["value"],
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const data = structuredData();
    data.set(argumentValueName("/value"), "42");

    expect(parseJsonSchemaArguments(complex, data)).toEqual({
      success: true,
      mode: "fields",
      data: { value: 42 },
    });
  });

  it("rejects an invalid field-local JSON draft instead of omitting it", () => {
    const complex = {
      type: "object",
      required: ["value"],
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const data = structuredData();
    data.set(argumentValueName("/value"), "{");

    expect(parseJsonSchemaArguments(complex, data)).toEqual({
      success: false,
      mode: "fields",
      errors: { "/value": "Enter valid JSON." },
    });
  });

  it("accepts raw JSON objects for complex schemas", () => {
    const unsupported = {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const data = new FormData();
    data.set(argumentModeName(), "raw");
    data.set(argumentRawName(), '{"value": 42}');

    expect(parseJsonSchemaArguments(unsupported, data)).toEqual({
      success: true,
      mode: "raw",
      data: { value: 42 },
    });
  });

  it("rejects invalid raw JSON and non-object roots", () => {
    const invalid = new FormData();
    invalid.set(argumentModeName(), "raw");
    invalid.set(argumentRawName(), "{");
    expect(parseJsonSchemaArguments(schema, invalid)).toEqual({
      success: false,
      mode: "raw",
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Enter valid JSON." },
    });

    const array = new FormData();
    array.set(argumentModeName(), "raw");
    array.set(argumentRawName(), "[]");
    expect(parseJsonSchemaArguments(schema, array)).toEqual({
      success: false,
      mode: "raw",
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Tool arguments must be a JSON object." },
    });

    const blank = new FormData();
    blank.set(argumentModeName(), "raw");
    blank.set(argumentRawName(), "   ");
    expect(parseJsonSchemaArguments(schema, blank)).toEqual({
      success: false,
      mode: "raw",
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Enter a JSON object." },
    });
  });

  it("bounds raw and generated argument payloads", () => {
    const oversized = "x".repeat(MAX_ARGUMENT_JSON_BYTES);
    const raw = new FormData();
    raw.set(argumentModeName(), "raw");
    raw.set(argumentRawName(), JSON.stringify({ value: oversized }));
    expect(parseJsonSchemaArguments(schema, raw)).toEqual({
      success: false,
      mode: "raw",
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: expect.stringContaining("64 KiB") },
    });

    const generated = structuredData();
    generated.set(argumentValueName("/query"), oversized);
    generated.set(argumentValueName("/limit"), "5");
    generated.set(argumentValueName("/options/strategy"), "fast");
    const permissiveSchema = {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    };
    expect(parseJsonSchemaArguments(permissiveSchema, generated)).toEqual({
      success: false,
      mode: "fields",
      errors: { [ROOT_ARGUMENTS_ERROR_PATH]: expect.stringContaining("64 KiB") },
    });
  });

  it("validates supported schemas in raw mode", () => {
    const data = new FormData();
    data.set(argumentModeName(), "raw");
    data.set(
      argumentRawName(),
      JSON.stringify({ query: "ok", limit: 100, options: { strategy: "fast" } }),
    );

    expect(parseJsonSchemaArguments(schema, data)).toEqual({
      success: false,
      mode: "raw",
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "/limit: Enter a value no greater than 20." },
    });
  });

  it("preserves a '__proto__' argument as data without changing the result prototype", () => {
    const prototypeSchema = {
      type: "object",
      required: ["__proto__"],
      properties: { ["__proto__"]: { type: "string" } },
    };
    const data = structuredData();
    data.set(argumentValueName("/__proto__"), "safe");

    const result = parseJsonSchemaArguments(prototypeSchema, data);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
    expect(Object.hasOwn(result.data, "__proto__")).toBe(true);
    expect(result.data["__proto__"]).toBe("safe");
  });

  it("preserves a raw '__proto__' argument without polluting global prototypes", () => {
    const data = new FormData();
    data.set(argumentModeName(), "raw");
    data.set(argumentRawName(), '{"__proto__":{"polluted":true}}');

    const result = parseJsonSchemaArguments({ type: "object", properties: {} }, data);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
    expect(Object.hasOwn(result.data, "__proto__")).toBe(true);
    expect(result.data["__proto__"]).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
