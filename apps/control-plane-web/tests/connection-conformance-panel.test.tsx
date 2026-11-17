import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionConformancePanel } from "../components/connection-conformance-panel";
import {
  conformanceRunSchema,
  controlPlaneApi,
  type ConformanceRun,
  type Connection,
} from "../lib/control-plane-api";
import {
  cancelConformanceRunMutationOptions,
  CONFORMANCE_RUN_POLL_INTERVAL_MS,
  conformanceRunPollInterval,
  conformanceRunQueryOptions,
  conformanceRunsQueryOptions,
  controlPlaneKeys,
  startConformanceRunMutationOptions,
} from "../lib/control-plane-queries";

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

const run: ConformanceRun = {
  runId: "8b7e1f0c-5d31-4f39-8be7-b29f2618e3f4",
  planId: "safe-discovery-v1",
  status: "completed",
  target: {
    kind: "connection",
    connectionId: connection.id,
    expectedRevision: connection.revision,
    runtimeGeneration: connection.runtimeGeneration,
  },
  createdAt: "2026-08-21T12:06:00.000Z",
  startedAt: "2026-08-21T12:06:00.000Z",
  finishedAt: "2026-08-21T12:06:01.000Z",
  report: {
    reportSchemaVersion: 1,
    fingerprintVersion: 1,
    runId: "8b7e1f0c-5d31-4f39-8be7-b29f2618e3f4",
    plan: {
      id: "safe-discovery-v1",
      version: "1.0.0",
      title: "Safe discovery",
      digest: `sha256:${"A".repeat(43)}`,
      checks: [{ id: "runtime.online", title: "Runtime online", risk: "read-only" }],
    },
    descriptor: {
      target: { kind: "connection", id: connection.id, revision: 2, generation: 3 },
      subject: { name: "@nest-mcp/nestjs", version: "2.0.0-alpha.0" },
    },
    startedAt: "2026-08-21T12:06:00.000Z",
    finishedAt: "2026-08-21T12:06:01.000Z",
    durationMs: 1_000,
    completion: "completed",
    verdict: "pass",
    counts: { pass: 1, warn: 0, fail: 0, skip: 0, error: 0 },
    checks: [
      {
        id: "runtime.online",
        title: "Runtime online",
        risk: "read-only",
        status: "pass",
        code: "RUNTIME_ONLINE",
        durationMs: 4,
        facts: { generation: 3, runtimeGeneration: 3 },
        factsOmittedCount: 0,
      },
    ],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conformance API contract", () => {
  it("strictly validates the bounded run and reusable report envelopes", () => {
    expect(conformanceRunSchema.parse(run)).toEqual(run);
    expect(() => conformanceRunSchema.parse({ ...run, rawPayload: { token: "secret" } })).toThrow();
    expect(() =>
      conformanceRunSchema.parse({
        ...run,
        report: { ...run.report, checks: [{ ...run.report?.checks[0], message: "raw error" }] },
      }),
    ).toThrow();
    expect(() =>
      conformanceRunSchema.parse({
        ...run,
        report: {
          ...run.report,
          counts: { pass: 0, warn: 0, fail: 0, skip: 0, error: 0 },
        },
      }),
    ).toThrow();
    expect(() =>
      conformanceRunSchema.parse({
        ...run,
        report: { ...run.report, runId: "74573c42-855d-49dd-a32a-8928380d4b69" },
      }),
    ).toThrow();
    expect(() => conformanceRunSchema.parse({ ...run, status: "stale" })).toThrow();
  });

  it("posts the exact generation-fenced target", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...run,
            status: "queued",
            startedAt: undefined,
            finishedAt: undefined,
            report: undefined,
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(controlPlaneApi.startConformanceRun(connection)).resolves.toMatchObject({
      runId: run.runId,
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/mcp/conformance/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          target: {
            kind: "connection",
            connectionId: connection.id,
            expectedRevision: connection.revision,
            runtimeGeneration: connection.runtimeGeneration,
          },
        }),
      }),
    );
  });

  it("unwraps scoped history and uses the exact detail and cancellation routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runs: [run] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(run), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(run), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      controlPlaneApi.listConformanceRuns(connection.id, connection.runtimeGeneration, 5),
    ).resolves.toEqual([run]);
    await expect(controlPlaneApi.getConformanceRun(run.runId)).resolves.toEqual(run);
    await expect(controlPlaneApi.cancelConformanceRun(run.runId)).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/mcp/conformance/runs?connectionId=${connection.id}&runtimeGeneration=3&limit=5`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/mcp/conformance/runs/${run.runId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/mcp/conformance/runs/${run.runId}/cancel`,
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });
});

describe("conformance query policy", () => {
  it("polls only queued and running detail views", () => {
    expect(conformanceRunPollInterval({ ...run, status: "queued", report: undefined })).toBe(
      CONFORMANCE_RUN_POLL_INTERVAL_MS,
    );
    expect(conformanceRunPollInterval({ ...run, status: "running", report: undefined })).toBe(
      CONFORMANCE_RUN_POLL_INTERVAL_MS,
    );
    expect(conformanceRunPollInterval({ ...run, status: "cancelling", report: undefined })).toBe(
      CONFORMANCE_RUN_POLL_INTERVAL_MS,
    );
    expect(conformanceRunPollInterval(run)).toBe(false);
  });

  it("keys history by connection generation and disables mutation retries", () => {
    expect(conformanceRunsQueryOptions(connection).queryKey).toEqual([
      "control-plane",
      "conformance",
      "runs",
      connection.id,
      connection.runtimeGeneration,
    ]);
    expect(conformanceRunQueryOptions(run.runId).retry).toBe(false);
    expect(startConformanceRunMutationOptions().retry).toBe(false);
    expect(cancelConformanceRunMutationOptions().retry).toBe(false);
  });
});

describe("ConnectionConformancePanel", () => {
  it("renders the latest verdict, counts, checks, and current-generation history", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(
      controlPlaneKeys.conformanceRuns(connection.id, connection.runtimeGeneration),
      [run],
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConnectionConformancePanel connection={connection} />
      </QueryClientProvider>,
    );

    expect(html).toContain("Repeatable conformance");
    expect(html).toContain("safe-discovery-v1");
    expect(html).toContain("Safe discovery");
    expect(html).toContain("Runtime online");
    expect(html).toContain("RUNTIME_ONLINE");
    expect(html).toContain("Current-generation history");
  });
});
