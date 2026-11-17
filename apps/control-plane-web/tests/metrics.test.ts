import { describe, expect, it } from "vitest";

import type { OperationMetrics } from "../lib/control-plane-api";
import {
  completedMetricCount,
  formatMetricBucketTime,
  formatMetricDuration,
  formatMetricPercent,
  formatMetricWindow,
  metricBucketAccessibleLabel,
  metricChartPercent,
  metricOperationKey,
  metricSuccessRate,
  sortOperationMetrics,
  sumMetricOutcomes,
} from "../lib/metrics";

const emptyDuration = {
  count: 0,
  averageMs: null,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
} as const;

describe("metrics presentation helpers", () => {
  it("derives completed counts and a zero-safe success rate", () => {
    expect(completedMetricCount({ success: 7, error: 2, cancelled: 1 })).toBe(10);
    expect(metricSuccessRate({ success: 7, error: 2, cancelled: 1 })).toBe(70);
    expect(metricSuccessRate({ success: 0, error: 0, cancelled: 0 })).toBeNull();
    expect(formatMetricPercent(null)).toBe("—");
    expect(formatMetricPercent(99.95)).toBe("<100%");
    expect(formatMetricPercent(100)).toBe("100%");
  });

  it("bounds chart percentages and handles an all-zero scale", () => {
    expect(metricChartPercent(5, 10)).toBe(50);
    expect(metricChartPercent(12, 10)).toBe(100);
    expect(metricChartPercent(0, 0)).toBe(0);
    expect(metricChartPercent(Number.NaN, 10)).toBe(0);
  });

  it("builds injective operation keys even when dimensions contain separators", () => {
    const first = {
      role: "client" as const,
      name: "a:b",
      kind: "request" as const,
      capability: "c",
    };
    const second = { ...first, name: "a", capability: "b:c" };

    expect(metricOperationKey(first)).not.toBe(metricOperationKey(second));
  });

  it("formats bounded window, latency, and UTC bucket labels", () => {
    const bucket = {
      startedAt: "2026-08-21T12:00:00.000Z",
      started: 3,
      outcomes: { success: 2, error: 1, cancelled: 0 },
      duration: { count: 3, averageMs: 15, p50Ms: 10, p95Ms: 25, maxMs: 30 },
    } as const;

    expect(formatMetricBucketTime(bucket.startedAt)).toBe("12:00:00 UTC");
    expect(formatMetricDuration(1_250)).toBe("1.3 s");
    expect(formatMetricWindow(10, 30)).toBe("5 minutes rolling window");
    expect(metricBucketAccessibleLabel(bucket)).toBe(
      "12:00:00 UTC: 2 successful, 1 error, 0 cancelled; p95 latency 25 ms.",
    );
  });

  it("sums rolling outcomes and sorts operation rows without mutating input", () => {
    const operations: readonly OperationMetrics[] = [
      {
        role: "client",
        name: "tools/list",
        kind: "request",
        capability: "tools",
        started: 1,
        active: 0,
        outcomes: { success: 1, error: 0, cancelled: 0 },
        duration: { count: 1, averageMs: 4, p50Ms: 4, p95Ms: 4, maxMs: 4 },
      },
      {
        role: "client",
        name: "tools/call",
        kind: "request",
        capability: "tools",
        started: 4,
        active: 1,
        outcomes: { success: 2, error: 1, cancelled: 0 },
        duration: { count: 3, averageMs: 8, p50Ms: 6, p95Ms: 12, maxMs: 15 },
      },
    ];

    expect(sortOperationMetrics(operations).map((operation) => operation.name)).toEqual([
      "tools/call",
      "tools/list",
    ]);
    expect(operations[0]?.name).toBe("tools/list");
    expect(
      sumMetricOutcomes([
        {
          startedAt: "2026-08-21T12:00:00.000Z",
          started: 0,
          outcomes: { success: 0, error: 0, cancelled: 0 },
          duration: emptyDuration,
        },
        {
          startedAt: "2026-08-21T12:00:10.000Z",
          started: 2,
          outcomes: { success: 1, error: 0, cancelled: 1 },
          duration: { count: 2, averageMs: 5, p50Ms: 4, p95Ms: 6, maxMs: 7 },
        },
      ]),
    ).toEqual({ success: 1, error: 0, cancelled: 1 });
  });
});
