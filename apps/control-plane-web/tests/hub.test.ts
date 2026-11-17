import { describe, expect, it } from "vitest";

import { hubNamespaceSchema, type Connection, type Hub } from "../lib/control-plane-api";
import {
  canExposeConnection,
  retainNewestEndpointSnapshot,
  suggestExposureNamespace,
} from "../lib/hub";

const connection: Connection = {
  id: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
  revision: 4,
  runtimeGeneration: 7,
  displayName: "Docs",
  desiredState: "online",
  deletionPending: false,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:05:00.000Z",
  transport: { kind: "http", host: "127.0.0.1:3200" },
  authentication: { kind: "none", configured: true },
  runtime: { phase: "online", lastTransitionAt: "2026-08-21T12:05:00.000Z" },
};

function hub(revision: number): Hub {
  return {
    revision,
    updatedAt: "2026-08-21T12:05:00.000Z",
    endpoint: { transport: "streamable-http", path: "/mcp/hub" },
    members: [],
    counts: { tools: 0, resources: 0, resourceTemplates: 0, prompts: 0 },
  };
}

describe("hub helpers", () => {
  it("only admits an undeleted desired-online connection with a live online runtime", () => {
    expect(canExposeConnection(connection)).toBe(true);
    expect(canExposeConnection({ ...connection, desiredState: "offline" })).toBe(false);
    expect(
      canExposeConnection({
        ...connection,
        runtime: { ...connection.runtime, phase: "degraded" },
      }),
    ).toBe(false);
    expect(canExposeConnection({ ...connection, deletionPending: true })).toBe(false);
  });

  it("creates canonical, unique, bounded human namespaces", () => {
    expect(suggestExposureNamespace("  Café Docs / Main  ", [])).toBe("cafe-docs-main");
    expect(suggestExposureNamespace("123 Server", [])).toBe("mcp-123-server");
    expect(suggestExposureNamespace("🧰", [])).toBe("mcp");
    expect(suggestExposureNamespace("Docs", [{ namespace: "docs" }])).toBe("docs-2");
    expect(
      suggestExposureNamespace("This is an extremely long connection display name", []).length,
    ).toBeLessThanOrEqual(32);
  });

  it("uses the same strict namespace grammar for form and response parsing", () => {
    expect(hubNamespaceSchema.parse("docs-2")).toBe("docs-2");
    for (const invalid of ["", "Docs", "docs_2", "-docs", "docs-", "2-docs", "a".repeat(33)]) {
      expect(hubNamespaceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("does not let a delayed lower revision replace the current hub snapshot", () => {
    expect(retainNewestEndpointSnapshot(hub(9), hub(8)).revision).toBe(9);
    expect(retainNewestEndpointSnapshot(hub(8), hub(9)).revision).toBe(9);
    expect(retainNewestEndpointSnapshot(undefined, hub(1)).revision).toBe(1);
  });
});
