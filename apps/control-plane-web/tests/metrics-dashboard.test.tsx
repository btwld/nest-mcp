import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MetricsDashboard } from "../components/metrics-dashboard";
import type { MetricsSnapshot } from "../lib/control-plane-api";

const snapshot: MetricsSnapshot = {
  scope: "process",
  startedAt: "2026-08-21T11:55:00.000Z",
  capturedAt: "2026-08-21T12:05:00.000Z",
  totals: {
    started: 6,
    active: 1,
    outcomes: { success: 3, error: 1, cancelled: 1 },
    duration: { count: 5, averageMs: 18, p50Ms: 12, p95Ms: 32, maxMs: 40 },
  },
  window: {
    bucketSeconds: 10,
    buckets: [
      {
        startedAt: "2026-08-21T12:04:40.000Z",
        started: 2,
        outcomes: { success: 1, error: 0, cancelled: 0 },
        duration: { count: 1, averageMs: 8, p50Ms: 8, p95Ms: 8, maxMs: 8 },
      },
      {
        startedAt: "2026-08-21T12:04:50.000Z",
        started: 4,
        outcomes: { success: 2, error: 1, cancelled: 1 },
        duration: { count: 4, averageMs: 20, p50Ms: 15, p95Ms: 32, maxMs: 40 },
      },
    ],
  },
  operations: [
    {
      role: "client",
      name: "tools/call",
      kind: "request",
      capability: "tools",
      started: 6,
      active: 1,
      outcomes: { success: 3, error: 1, cancelled: 1 },
      duration: { count: 5, averageMs: 18, p50Ms: 12, p95Ms: 32, maxMs: 40 },
    },
  ],
  operationsTruncated: false,
};

describe("MetricsDashboard", () => {
  it("renders semantic charts, exact bucket text, and a headed breakdown table", () => {
    const html = renderToStaticMarkup(
      <MetricsDashboard
        error={null}
        loading={false}
        onRetry={() => undefined}
        snapshot={snapshot}
      />,
    );

    expect(html.match(/<figure/g)).toHaveLength(2);
    expect(html.match(/<figcaption/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Operation outcome buckets"');
    expect(html).toContain('aria-label="P95 latency buckets"');
    expect(html).toContain("12:04:50 UTC: 2 successful, 1 error, 1 cancelled; p95 latency 32 ms.");
    expect(html).toContain("resets when API restarts");
    expect(html).toContain("MCP operation totals grouped by role");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html.match(/role="region"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Scrollable MCP operation breakdown"');
  });

  it("announces the initial loading state", () => {
    const html = renderToStaticMarkup(
      <MetricsDashboard error={null} loading onRetry={() => undefined} snapshot={undefined} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading MCP operation metrics.");
  });

  it("announces a background refresh failure while preserving the last snapshot", () => {
    const html = renderToStaticMarkup(
      <MetricsDashboard
        error={new Error("refresh failed")}
        loading={false}
        onRetry={() => undefined}
        snapshot={snapshot}
      />,
    );

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Showing the last valid capture");
    expect(html).toContain("Update delayed");
  });

  it("renders an alert and named retry action when the initial request fails", () => {
    const html = renderToStaticMarkup(
      <MetricsDashboard
        error={new Error("offline")}
        loading={false}
        onRetry={() => undefined}
        snapshot={undefined}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Metrics snapshot unavailable");
    expect(html).toContain("Retry");
  });
});
