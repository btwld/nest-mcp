import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JsonCodeDetails, JsonCodeEditor } from "../components/json-code-editor";
import { JsonSchemaArgumentForm } from "../components/json-schema-argument-form";

describe("JsonCodeEditor", () => {
  it("keeps an SSR-safe native form control while CodeMirror is lazy loaded", () => {
    const html = renderToStaticMarkup(
      <JsonCodeEditor
        ariaLabel="Tool arguments as JSON"
        defaultValue={'{"query":"mcp"}'}
        editorId="arguments-json"
        name="tool.arguments"
      />,
    );

    expect(html).toContain('data-json-code-editor=""');
    expect(html).toContain('name="tool.arguments"');
    expect(html).toContain('aria-label="Tool arguments as JSON"');
    expect(html).toContain('id="arguments-json"');
    expect(html).toContain("Format");
    expect(html).toContain("{&quot;query&quot;:&quot;mcp&quot;}");
  });

  it("keeps an ambiguous field local to a CodeMirror-backed JSON fallback", () => {
    const html = renderToStaticMarkup(
      <JsonSchemaArgumentForm
        schema={{
          type: "object",
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        }}
      />,
    );

    expect(html).not.toContain("Raw JSON required");
    expect(html).toContain("Form");
    expect(html).toContain('name="tool-arguments.fields.%2Fvalue.value"');
    expect(html).toContain('aria-label="JSON value for /value"');
    expect(html).toContain('aria-label="Include value"');
    expect(html).toContain('data-included="false"');
    expect(html).toContain('hidden="" id="tool-arguments-field-%2Fvalue-body"');
    expect(html).toContain("Format");
  });

  it("keeps Zoho sibling fields when a nested array item uses anyOf", () => {
    const html = renderToStaticMarkup(
      <JsonSchemaArgumentForm
        schema={{
          type: "object",
          required: ["query_params"],
          properties: {
            query_params: {
              type: "object",
              required: ["page"],
              properties: {
                page: { type: "integer" },
                criteria: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      anyOf: [{ type: "object", properties: { cfid: { type: "string" } } }],
                    },
                  },
                },
              },
            },
          },
        }}
      />,
    );

    expect(html).not.toContain("Raw JSON required");
    expect(html).toContain("page");
    expect(html).toContain("criteria");
    expect(html).toContain('aria-label="JSON array for /query_params/criteria"');
    expect(html).toContain('data-schema-path="/query_params"');
    expect(html).toContain('data-schema-depth="0"');
    expect(html).toContain('data-schema-path="/query_params/criteria"');
    expect(html).toContain('data-schema-depth="1"');
    expect(html).toContain('aria-label="Include criteria"');
  });

  it("associates editor errors with the editable surface", () => {
    const html = renderToStaticMarkup(
      <JsonCodeEditor
        ariaLabel="Arguments JSON"
        editorId="arguments-json"
        error="Fix the JSON syntax before formatting."
      />,
    );

    expect(html).toContain('aria-describedby="arguments-json-error"');
    expect(html).toContain('id="arguments-json-error"');
    expect(html).toContain('role="alert"');
  });

  it("keeps a static fallback and does not mount CodeMirror until details are opened", () => {
    const closed = renderToStaticMarkup(
      <JsonCodeDetails ariaLabel="Input schema JSON" code={'{"type":"object"}'}>
        Input schema
      </JsonCodeDetails>,
    );
    const open = renderToStaticMarkup(
      <JsonCodeDetails ariaLabel="Input schema JSON" code={'{"type":"object"}'} defaultOpen>
        Input schema
      </JsonCodeDetails>,
    );

    expect(closed).toContain("Input schema");
    expect(closed).toContain("{&quot;type&quot;:&quot;object&quot;}");
    expect(closed).not.toContain('data-json-code-editor=""');
    expect(open).toContain("{&quot;type&quot;:&quot;object&quot;}");
    expect(open).toContain('data-json-code-editor=""');
    expect(open).toContain('aria-label="Input schema JSON"');
  });
});
