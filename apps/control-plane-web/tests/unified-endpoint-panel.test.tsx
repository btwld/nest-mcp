import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnifiedEndpointPanel } from "../components/unified-endpoint-panel";
import type { Hub } from "../lib/control-plane-api";

const snapshot: Hub = {
  revision: 11,
  updatedAt: "2026-08-21T12:06:00.000Z",
  endpoint: { transport: "streamable-http", path: "/mcp/hub" },
  members: [
    {
      connectionId: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
      connectionRevision: 4,
      runtimeGeneration: 7,
      namespace: "docs",
      displayName: "Docs server",
      attachedAt: "2026-08-21T12:05:30.000Z",
      runtime: { phase: "online" },
    },
  ],
  counts: { tools: 1, resources: 0, resourceTemplates: 0, prompts: 0 },
};

describe("UnifiedEndpointPanel", () => {
  it("renders a compact endpoint summary without exposing internal routing details", () => {
    const html = renderToStaticMarkup(
      <UnifiedEndpointPanel
        actionsDisabled={false}
        error={null}
        loading={false}
        onRefresh={async () => undefined}
        onRetry={() => undefined}
        refreshPending={false}
        snapshot={snapshot}
      />,
    );

    expect(html).toContain("Unified MCP endpoint");
    expect(html).toContain("/mcp/hub");
    expect(html).toContain("1 MCP available");
    expect(html).toContain("Copy unified MCP endpoint path");
    expect(html).toContain("Add or remove an MCP from its MCP card");
    expect(html).toContain("1 tool");
    expect(html).toContain("0 resources");
    expect(html).toContain("0 templates");
    expect(html).toContain("0 prompts");
    expect(html).not.toContain("Docs server");
    expect(html).not.toContain("docs");
    expect(html).not.toContain("generation");
    expect(html).not.toContain("revision");
  });

  it("announces initial loading and failure independently", () => {
    const loading = renderToStaticMarkup(
      <UnifiedEndpointPanel
        actionsDisabled={false}
        error={null}
        loading
        onRefresh={async () => undefined}
        onRetry={() => undefined}
        refreshPending={false}
        snapshot={undefined}
      />,
    );
    const failed = renderToStaticMarkup(
      <UnifiedEndpointPanel
        actionsDisabled={false}
        error={new Error("offline")}
        loading={false}
        onRefresh={async () => undefined}
        onRetry={() => undefined}
        refreshPending={false}
        snapshot={undefined}
      />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading unified MCP endpoint");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Unified MCP endpoint unavailable");
    expect(failed).toContain("Retry");
  });

  it("preserves the last known endpoint status during an isolated refresh error", () => {
    const html = renderToStaticMarkup(
      <UnifiedEndpointPanel
        actionsDisabled={false}
        error={new Error("delayed")}
        loading={false}
        onRefresh={async () => undefined}
        onRetry={() => undefined}
        refreshPending={false}
        snapshot={snapshot}
      />,
    );

    expect(html).toContain("Showing the last known endpoint status");
    expect(html).toContain("1 MCP available");
    expect(html).toContain('aria-live="polite"');
  });
});
