import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  controlPlaneApi,
  type Connection,
  type Hub,
  type RuntimeManager,
} from "../lib/control-plane-api";
import {
  attachHubMemberMutationOptions,
  connectionPollInterval,
  controlPlaneKeys,
  detachHubMemberMutationOptions,
  HEALTH_POLL_INTERVAL_MS,
  hubCatalogQueryOptions,
  hubQueryOptions,
  liveHealthQueryOptions,
  METRICS_POLL_INTERVAL_MS,
  metricsQueryOptions,
  promptGetMutationOptions,
  readyHealthQueryOptions,
  refreshHubCatalogMutationOptions,
  resourceReadMutationOptions,
  runtimePollInterval,
  toolCallMutationOptions,
  TRANSIENT_POLL_INTERVAL_MS,
} from "../lib/control-plane-queries";

afterEach(() => {
  vi.restoreAllMocks();
});

function connectionWithPhase(phase: Connection["runtime"]["phase"]): Connection {
  return {
    id: "3d9be1bd-faaa-45c8-8ba0-e7e747f19c71",
    revision: 1,
    runtimeGeneration: 4,
    displayName: "Docs",
    desiredState: "online",
    deletionPending: false,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    transport: { kind: "http", host: "127.0.0.1:3200" },
    authentication: { kind: "none", configured: true },
    runtime: { phase, lastTransitionAt: "2026-08-21T12:00:00.000Z" },
  };
}

const settledRuntime: RuntimeManager = {
  closed: false,
  maxConnections: 8,
  connectionCount: 1,
  pendingConnectionCount: 0,
  activeConnectionCount: 1,
  closingConnectionCount: 0,
  quarantinedConnectionCount: 0,
  operationReferenceCount: 1,
  onlineKeeperCount: 1,
};

const hub: Hub = {
  revision: 7,
  updatedAt: "2026-08-21T12:05:00.000Z",
  endpoint: { transport: "streamable-http", path: "/mcp/hub" },
  members: [],
  counts: { tools: 0, resources: 0, resourceTemplates: 0, prompts: 0 },
};

describe("control-plane query policy", () => {
  it("polls only connection phases that can still reconcile", () => {
    expect(connectionPollInterval([connectionWithPhase("connecting")])).toBe(
      TRANSIENT_POLL_INTERVAL_MS,
    );
    expect(connectionPollInterval([connectionWithPhase("degraded")])).toBe(
      TRANSIENT_POLL_INTERVAL_MS,
    );
    expect(connectionPollInterval([connectionWithPhase("online")])).toBe(false);
    expect(connectionPollInterval([connectionWithPhase("failed")])).toBe(false);
  });

  it("polls aggregate capacity only while leases are pending or closing", () => {
    expect(runtimePollInterval(settledRuntime)).toBe(false);
    expect(runtimePollInterval({ ...settledRuntime, pendingConnectionCount: 1 })).toBe(
      TRANSIENT_POLL_INTERVAL_MS,
    );
    expect(runtimePollInterval({ ...settledRuntime, closingConnectionCount: 1 })).toBe(
      TRANSIENT_POLL_INTERVAL_MS,
    );
  });

  it("keys catalog cache entries by connection and runtime generation", () => {
    expect(controlPlaneKeys.catalog("connection-a", 7)).toEqual([
      "control-plane",
      "catalog",
      "connection-a",
      7,
    ]);
  });

  it("does not poll the unified endpoint status", () => {
    const hubOptions = hubQueryOptions();

    expect(hubOptions.queryKey).toEqual(["control-plane", "hub"]);
    expect(hubOptions.refetchInterval).toBeUndefined();
  });

  it("polls liveness and readiness independently", () => {
    const live = liveHealthQueryOptions();
    const ready = readyHealthQueryOptions();

    expect(live.queryKey).toEqual(["control-plane", "health", "live"]);
    expect(ready.queryKey).toEqual(["control-plane", "health", "ready"]);
    expect(live.refetchInterval).toBe(HEALTH_POLL_INTERVAL_MS);
    expect(ready.refetchInterval).toBe(HEALTH_POLL_INTERVAL_MS);
    expect(live.retry).toBe(1);
    expect(ready.retry).toBe(1);
  });

  it("loads the hub catalog only after the hub snapshot is available", () => {
    expect(hubCatalogQueryOptions(undefined).enabled).toBe(false);
    expect(hubCatalogQueryOptions(7).enabled).toBe(true);
    expect(hubCatalogQueryOptions(7).queryKey).toEqual(["control-plane", "hub", "catalog", 7]);
  });

  it("forwards endpoint-status cancellation", async () => {
    const snapshot = vi.spyOn(controlPlaneApi, "hubSnapshot").mockResolvedValue(hub);
    const controller = new AbortController();
    const queryClient = new QueryClient();
    const hubOptions = hubQueryOptions();

    if (typeof hubOptions.queryFn !== "function") {
      throw new Error("Expected a callable endpoint-status query function.");
    }
    await expect(
      hubOptions.queryFn({
        client: queryClient,
        meta: undefined,
        queryKey: hubOptions.queryKey,
        signal: controller.signal,
      }),
    ).resolves.toEqual(hub);
    expect(snapshot).toHaveBeenCalledWith(controller.signal);
  });

  it("never retries endpoint exposure mutations and delegates exact fenced inputs", async () => {
    const connection = connectionWithPhase("online");
    const member: Hub["members"][number] = {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      runtimeGeneration: connection.runtimeGeneration,
      namespace: "docs",
      displayName: connection.displayName,
      attachedAt: "2026-08-21T12:05:00.000Z",
      runtime: { phase: "online" },
    };
    const attach = vi.spyOn(controlPlaneApi, "attachHubMember").mockResolvedValue(hub);
    const detach = vi.spyOn(controlPlaneApi, "detachHubMember").mockResolvedValue();
    const refresh = vi.spyOn(controlPlaneApi, "refreshHubCatalog").mockResolvedValue(hub);
    const attachOptions = attachHubMemberMutationOptions();
    const detachOptions = detachHubMemberMutationOptions();
    const refreshOptions = refreshHubCatalogMutationOptions();

    expect(attachOptions.retry).toBe(false);
    expect(detachOptions.retry).toBe(false);
    expect(refreshOptions.retry).toBe(false);
    await attachOptions.mutationFn?.(
      { connection, hubRevision: 6, namespace: "docs" },
      { client: new QueryClient(), meta: undefined, mutationKey: attachOptions.mutationKey },
    );
    await detachOptions.mutationFn?.(
      { hubRevision: 7, member },
      { client: new QueryClient(), meta: undefined, mutationKey: detachOptions.mutationKey },
    );
    await refreshOptions.mutationFn?.(7, {
      client: new QueryClient(),
      meta: undefined,
      mutationKey: refreshOptions.mutationKey,
    });
    expect(attach).toHaveBeenCalledWith({
      connectionId: connection.id,
      namespace: "docs",
      expectedHubRevision: 6,
      expectedConnectionRevision: connection.revision,
      runtimeGeneration: connection.runtimeGeneration,
    });
    expect(detach).toHaveBeenCalledWith(connection.id, 7, connection.runtimeGeneration);
    expect(refresh).toHaveBeenCalledWith(7);
  });

  it("polls process metrics every five seconds only while the document is active", () => {
    const options = metricsQueryOptions();

    expect(options.queryKey).toEqual(["control-plane", "metrics"]);
    expect(options.refetchInterval).toBe(METRICS_POLL_INTERVAL_MS);
    expect(METRICS_POLL_INTERVAL_MS).toBe(5_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("never retries tool execution and delegates the typed mutation input", async () => {
    const result = { content: [{ type: "text", text: "done" }] };
    const callTool = vi.spyOn(controlPlaneApi, "callTool").mockResolvedValue(result);
    const options = toolCallMutationOptions("connection-a");
    const input = { name: "search", arguments: { query: "MCP" } };

    expect(options.mutationKey).toEqual(["control-plane", "tool-call", "connection-a"]);
    expect(options.retry).toBe(false);
    await expect(
      options.mutationFn?.(input, {
        client: new QueryClient(),
        meta: undefined,
        mutationKey: options.mutationKey,
      }),
    ).resolves.toEqual(result);
    expect(callTool).toHaveBeenCalledWith("connection-a", input);
  });

  it("never retries resource reads or prompt rendering and forwards exact inputs", async () => {
    const resourceResult = { contents: [{ uri: "docs://guide", text: "Guide" }] };
    const promptResult = {
      messages: [{ role: "user" as const, content: { type: "text", text: "Review MCP" } }],
    };
    const readResource = vi
      .spyOn(controlPlaneApi, "readResource")
      .mockResolvedValue(resourceResult);
    const getPrompt = vi.spyOn(controlPlaneApi, "getPrompt").mockResolvedValue(promptResult);
    const readOptions = resourceReadMutationOptions("connection-a");
    const promptOptions = promptGetMutationOptions("connection-a");
    const readInput = { uri: "docs://guide" };
    const promptInput = { name: "review", arguments: { topic: "MCP" } };

    expect(readOptions.mutationKey).toEqual(["control-plane", "resource-read", "connection-a"]);
    expect(promptOptions.mutationKey).toEqual(["control-plane", "prompt-get", "connection-a"]);
    expect(readOptions.retry).toBe(false);
    expect(promptOptions.retry).toBe(false);
    await expect(
      readOptions.mutationFn?.(readInput, {
        client: new QueryClient(),
        meta: undefined,
        mutationKey: readOptions.mutationKey,
      }),
    ).resolves.toEqual(resourceResult);
    await expect(
      promptOptions.mutationFn?.(promptInput, {
        client: new QueryClient(),
        meta: undefined,
        mutationKey: promptOptions.mutationKey,
      }),
    ).resolves.toEqual(promptResult);
    expect(readResource).toHaveBeenCalledWith("connection-a", readInput);
    expect(getPrompt).toHaveBeenCalledWith("connection-a", promptInput);
  });
});
