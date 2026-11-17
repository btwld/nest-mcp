import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogPanel, PromptItem, ResourceItem } from "../components/catalog-panel";
import type { Catalog, Connection } from "../lib/control-plane-api";
import { controlPlaneKeys } from "../lib/control-plane-queries";

const connection: Connection = {
  id: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
  revision: 2,
  runtimeGeneration: 3,
  displayName: "Docs",
  desiredState: "online",
  deletionPending: false,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:05:00.000Z",
  transport: { kind: "http", host: "127.0.0.1:3200" },
  authentication: { kind: "none", configured: true },
  runtime: {
    phase: "online",
    lastTransitionAt: "2026-08-21T12:05:00.000Z",
    protocolVersion: "2025-11-25",
    protocolEra: "modern",
  },
};

const catalog: Catalog = {
  connectionId: connection.id,
  runtimeGeneration: connection.runtimeGeneration,
  discoveredAt: "2026-08-21T12:06:00.000Z",
  tools: [{ name: "search", inputSchema: { type: "object" } }],
  resources: [{ name: "guide", uri: "docs://guide", mimeType: "text/plain" }],
  resourceTemplates: [],
  prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }],
};

describe("CatalogPanel", () => {
  it("maps loaded resources and prompts into explicit workbench actions", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(
      controlPlaneKeys.catalog(connection.id, connection.runtimeGeneration),
      catalog,
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CatalogPanel connection={connection} />
      </QueryClientProvider>,
    );

    expect(html).toContain("Current observations");
    expect(html).toContain("Resources");
    expect(html).toContain("Prompts");

    const resourceHtml = renderToStaticMarkup(
      <ResourceItem
        connection={connection}
        onRead={() => undefined}
        pending={false}
        resource={catalog.resources[0]!}
      />,
    );
    const promptHtml = renderToStaticMarkup(
      <PromptItem
        connection={connection}
        onGet={() => undefined}
        pending={false}
        prompt={catalog.prompts[0]!}
      />,
    );
    expect(resourceHtml).toContain("Read this exact advertised URI");
    expect(resourceHtml).toContain("Read</button>");
    expect(promptHtml).toContain("Provide text arguments");
    expect(promptHtml).toContain("Render</button>");
  });
});
