import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HubCatalogExplorer } from "../components/hub-catalog-explorer";
import type { HubCatalog } from "../lib/control-plane-api";

const catalog: HubCatalog = {
  revision: 12,
  publishedAt: "2026-08-21T12:06:00.000Z",
  tools: [
    {
      namespace: "docs",
      sourceName: "search",
      projectedName: "mcp.docs.search",
      definition: { name: "search" },
    },
  ],
  resources: [
    {
      namespace: "assets",
      sourceName: "brand-guide",
      projectedName: "mcp.assets.brand-guide",
      projectedUri: "mcp+hub://assets/brand-guide",
      definition: { name: "brand-guide", uri: "file:///brand-guide.md" },
    },
  ],
  resourceTemplates: [
    {
      namespace: "docs",
      sourceName: "article",
      projectedName: "mcp.docs.article",
      projectedUriTemplate: "mcp+hub://docs/articles/{slug}",
      definition: { name: "article", uriTemplate: "docs:///articles/{slug}" },
    },
  ],
  prompts: [
    {
      namespace: "writer",
      sourceName: "summarize",
      projectedName: "mcp.writer.summarize",
      definition: { name: "summarize" },
    },
  ],
};

describe("HubCatalogExplorer", () => {
  it("renders catalog metadata, capability counts, and a searchable mapping surface", () => {
    const html = renderToStaticMarkup(<HubCatalogExplorer catalog={catalog} />);

    expect(html).toContain("Projected catalog");
    expect(html).toContain("Revision 12");
    expect(html).toContain('dateTime="2026-08-21T12:06:00.000Z"');
    expect(html).toContain("4 projected capabilities");
    expect(html).toContain("Search projected catalog");
    expect(html).toContain("Search namespace, source, projected name, or URI");
    expect(html).toContain("Tools");
    expect(html).toContain("Resources");
    expect(html).toContain("Templates");
    expect(html).toContain("Prompts");
  });

  it("shows namespace and source-to-projected tool mappings", () => {
    const html = renderToStaticMarkup(<HubCatalogExplorer catalog={catalog} />);

    expect(html).toContain("Source identifier");
    expect(html).toContain("docs");
    expect(html).toContain("search");
    expect(html).toContain("is projected as");
    expect(html).toContain("Projected name");
    expect(html).toContain("mcp.docs.search");
  });

  it.each([
    {
      label: "resource URI",
      catalog: { ...catalog, tools: [], resourceTemplates: [], prompts: [] },
      expectedLabel: "Projected URI",
      expectedValue: "mcp+hub://assets/brand-guide",
    },
    {
      label: "resource template URI",
      catalog: { ...catalog, tools: [], resources: [], prompts: [] },
      expectedLabel: "Projected URI template",
      expectedValue: "mcp+hub://docs/articles/{slug}",
    },
    {
      label: "prompt name",
      catalog: { ...catalog, tools: [], resources: [], resourceTemplates: [] },
      expectedLabel: "Projected name",
      expectedValue: "mcp.writer.summarize",
    },
  ])(
    "shows the projected $label mapping",
    ({ catalog: focusedCatalog, expectedLabel, expectedValue }) => {
      const html = renderToStaticMarkup(<HubCatalogExplorer catalog={focusedCatalog} />);

      expect(html).toContain(expectedLabel);
      expect(html).toContain(expectedValue);
    },
  );

  it("renders an explicit empty state for a catalog without capabilities", () => {
    const html = renderToStaticMarkup(
      <HubCatalogExplorer
        catalog={{
          revision: 1,
          publishedAt: "2026-08-21T12:06:00.000Z",
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        }}
      />,
    );

    expect(html).toContain("0 projected capabilities");
    expect(html).toContain("No mappings");
    expect(html).toContain("No projected tools match the current search");
  });
});
