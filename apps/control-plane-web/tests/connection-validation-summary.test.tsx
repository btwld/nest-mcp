import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConnectionValidationSummary,
  connectionValidationChecks,
} from "../components/connection-validation-summary";
import type { Catalog, Connection } from "../lib/control-plane-api";

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
  runtime: {
    phase: "online",
    lastTransitionAt: "2026-08-21T12:05:00.000Z",
    connectedAt: "2026-08-21T12:05:00.000Z",
    protocolVersion: "2025-11-25",
    protocolEra: "modern",
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      completion: false,
      subscriptions: false,
    },
  },
};

const catalog: Catalog = {
  connectionId: connection.id,
  runtimeGeneration: connection.runtimeGeneration,
  discoveredAt: "2026-08-21T12:06:00.000Z",
  tools: [{ name: "search", inputSchema: { type: "object" } }],
  resources: [{ name: "guide", uri: "docs://guide" }],
  resourceTemplates: [],
  prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }],
};

describe("ConnectionValidationSummary", () => {
  it("reports named checks instead of an opaque aggregate score", () => {
    const html = renderToStaticMarkup(
      <ConnectionValidationSummary catalog={catalog} connection={connection} />,
    );

    expect(html).toContain("Current observations");
    expect(html).toContain("Authorization");
    expect(html).toContain("Runtime online");
    expect(html).toContain("Protocol observed");
    expect(html).toContain("Catalog discovered");
    expect(html).toContain("Workbench coverage");
    expect(html).toContain("5 pass");
    expect(html).toContain("1 unknown");
    expect(html).toContain("Tool schemas");
    expect(html).toContain("3 of 3 capabilities");
    expect(html).not.toMatch(/\d+%/u);
  });

  it("uses warn and unknown states for incomplete evidence and unsupported workbenches", () => {
    const incompleteConnection: Connection = {
      ...connection,
      desiredState: "offline",
      authentication: { kind: "oauth", status: "authorization-required" },
      runtime: {
        phase: "offline",
        lastTransitionAt: connection.runtime.lastTransitionAt,
      },
    };
    const uncoveredCatalog: Catalog = {
      ...catalog,
      runtimeGeneration: 6,
      tools: [
        {
          name: "async-only",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        },
      ],
      resources: [],
      resourceTemplates: [{ name: "guide", uriTemplate: "docs://guide/{slug}" }],
      prompts: [],
    };

    const checks = connectionValidationChecks(incompleteConnection, uncoveredCatalog);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "authorization", status: "warn" }),
        expect.objectContaining({ id: "runtime", status: "warn" }),
        expect.objectContaining({ id: "protocol", status: "unknown" }),
        expect.objectContaining({ id: "catalog", status: "warn" }),
        expect.objectContaining({ id: "workbench", status: "warn" }),
      ]),
    );
  });

  it("does not claim an unauthenticated connection is valid before it is online", () => {
    const checks = connectionValidationChecks(
      {
        ...connection,
        desiredState: "offline",
        runtime: { phase: "offline", lastTransitionAt: connection.runtime.lastTransitionAt },
      },
      undefined,
    );

    expect(checks).toContainEqual(
      expect.objectContaining({ id: "authorization", status: "unknown" }),
    );
  });

  it("warns for an explicitly unsupported tool schema draft", () => {
    const checks = connectionValidationChecks(connection, {
      ...catalog,
      tools: [
        {
          name: "legacy",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
          },
        },
      ],
    });

    expect(checks).toContainEqual(expect.objectContaining({ id: "schemas", status: "warn" }));
  });
});
