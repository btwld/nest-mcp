import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PromptGetResultView, ResourceReadResultView } from "../components/capability-result-view";
import type { GetPromptResult, ReadResourceResult } from "../lib/control-plane-api";

describe("capability result views", () => {
  it("bounds resource item and text previews while summarizing binary payloads", () => {
    const marker = "TAIL-MUST-BE-OMITTED";
    const result: ReadResourceResult = {
      contents: Array.from({ length: 55 }, (_, index) =>
        index === 0
          ? {
              uri: "docs://guide/0",
              text: `${"x".repeat(70 * 1_024)}${marker}`,
              blob: "encoded-secret".repeat(2_000),
            }
          : { uri: `docs://guide/${String(index)}`, text: `Guide ${String(index)}` },
      ),
    };

    const html = renderToStaticMarkup(<ResourceReadResultView result={result} />);

    expect(html).toContain("Resource read completed");
    expect(html).toContain("55 content items");
    expect(html).toContain("5 additional items are omitted");
    expect(html).toContain("encoded payload omitted");
    expect(html).not.toContain("encoded-secretencoded-secret");
    expect(html).not.toContain(marker);
  });

  it("renders prompt roles, future content blocks, and bounded raw output", () => {
    const result: GetPromptResult = {
      description: "Review the validation plan",
      messages: [
        { role: "user", content: { type: "text", text: "Review MCP" } },
        {
          role: "assistant",
          content: {
            type: "citation",
            uri: "docs://guide",
            evidence: ["one", "two"],
            ["__proto__"]: { marker: "prototype-key-preserved" },
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<PromptGetResultView result={result} />);

    expect(html).toContain("Prompt rendered");
    expect(html).toContain("2 messages");
    expect(html).toContain("User");
    expect(html).toContain("Assistant");
    expect(html).toContain("citation");
    expect(html).toContain("__proto__");
    expect(html).toContain("prototype-key-preserved");
    expect(html).toContain("Bounded raw response");
  });

  it("globally bounds wide raw JSON previews", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `field-${String(index)}`,
        `${"x".repeat(16 * 1_024)}${index === 99 ? "TAIL-MUST-BE-OMITTED" : ""}`,
      ]),
    );
    const result: GetPromptResult = {
      messages: [{ role: "assistant", content: { type: "future", ...wide } }],
    };

    const html = renderToStaticMarkup(<PromptGetResultView result={result} />);

    expect(html).toContain("Additional JSON preview characters omitted");
    expect(html).not.toContain("TAIL-MUST-BE-OMITTED");
    expect(html.length).toBeLessThan(150_000);
  });
});
