import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  canConnectWithAuthentication,
  ConnectionAuthenticationPanel,
} from "../components/connection-authentication";
import type { Connection } from "../lib/control-plane-api";

const connection: Connection = {
  id: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
  revision: 7,
  runtimeGeneration: 4,
  displayName: "Zoho Projects",
  desiredState: "offline",
  deletionPending: false,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:00:00.000Z",
  transport: { kind: "http", host: "testmcp-905604195.zohomcp.com" },
  authentication: {
    kind: "oauth",
    status: "authorization-required",
    authorizationServerHost: "testmcp-905604195.zohomcp.com",
    scopes: ["ZohoProjects.bugs.READ", "ZohoMCP.tool.execute"],
  },
  runtime: { phase: "offline", lastTransitionAt: "2026-08-21T12:00:00.000Z" },
};

describe("ConnectionAuthenticationPanel", () => {
  it("renders a native revision-fenced POST authorization action", () => {
    const html = renderToStaticMarkup(
      <ConnectionAuthenticationPanel connection={connection} disabled={false} />,
    );

    expect(html).toContain("OAuth · authorization required");
    expect(html).toContain("Authorize this MCP before connecting it.");
    expect(html).toContain('method="post"');
    expect(html).toContain(
      `/api/v1/mcp/connections/${connection.id}/oauth/authorize?expectedRevision=7`,
    );
    expect(html).toContain("ZohoProjects.bugs.READ");
    expect(html).not.toContain("accessToken");
    expect(html).not.toContain("clientId");
  });

  it("gates connection readiness on OAuth authorization status", () => {
    expect(canConnectWithAuthentication({ kind: "none", configured: true })).toBe(true);
    expect(canConnectWithAuthentication(connection.authentication)).toBe(false);
    expect(canConnectWithAuthentication({ kind: "oauth", status: "authorized" })).toBe(true);
  });

  it("offers reauthorization for a safe failure projection", () => {
    const html = renderToStaticMarkup(
      <ConnectionAuthenticationPanel
        connection={{
          ...connection,
          authentication: {
            kind: "oauth",
            status: "failed",
            errorCode: "OAUTH_ACCESS_DENIED",
          },
        }}
        disabled={false}
      />,
    );

    expect(html).toContain("Reauthorize");
    expect(html).toContain("OAUTH_ACCESS_DENIED");
  });
});
