import { describe, expect, it } from "vitest";

import { formatJsonDocument, stringifyJsonDocument } from "../lib/json-document";

describe("formatJsonDocument", () => {
  it("formats valid JSON with stable two-space indentation", () => {
    expect(formatJsonDocument('{"query":"mcp","options":{"limit":3}}')).toEqual({
      success: true,
      value: '{\n  "query": "mcp",\n  "options": {\n    "limit": 3\n  }\n}',
    });
  });

  it("keeps invalid JSON out of the formatter result", () => {
    expect(formatJsonDocument("{")).toEqual({
      success: false,
      message: "Fix the JSON syntax before formatting.",
    });
  });
});

describe("stringifyJsonDocument", () => {
  it("serializes JSON values for read-only code views", () => {
    expect(stringifyJsonDocument({ type: "object" }, "fallback")).toBe('{\n  "type": "object"\n}');
  });

  it("uses a safe fallback for unsupported or circular values", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(stringifyJsonDocument(circular, "unavailable")).toBe("unavailable");
    expect(stringifyJsonDocument(undefined, "unavailable")).toBe("unavailable");
    expect(stringifyJsonDocument(BigInt(1), "unavailable")).toBe("unavailable");
  });
});
