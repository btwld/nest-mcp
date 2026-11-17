import type { MetricOutcomes, MetricsBucket, OperationMetrics } from "./control-plane-api";

const metricNumber = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const metricPercent = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});
const utcBucketTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function completedMetricCount(outcomes: MetricOutcomes): number {
  return outcomes.success + outcomes.error + outcomes.cancelled;
}

export function metricSuccessRate(outcomes: MetricOutcomes): number | null {
  const completed = completedMetricCount(outcomes);
  return completed === 0 ? null : (outcomes.success / completed) * 100;
}

export function metricChartPercent(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || value <= 0 || maximum <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / maximum) * 100));
}

export function formatMetricDuration(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000) return `${metricNumber.format(value / 1_000)} s`;
  return `${metricNumber.format(value)} ms`;
}

export function formatMetricPercent(value: number | null): string {
  if (value === null) return "—";
  const formatted = metricPercent.format(value);
  return value < 100 && formatted === metricPercent.format(100) ? "<100%" : `${formatted}%`;
}

export function formatMetricBucketTime(value: string): string {
  return `${utcBucketTime.format(new Date(value))} UTC`;
}

export function formatMetricWindow(bucketSeconds: number, bucketCount: number): string {
  const windowSeconds = bucketSeconds * bucketCount;
  if (windowSeconds === 0) return `${String(bucketSeconds)} second buckets`;
  if (windowSeconds < 60) return `${String(windowSeconds)} second rolling window`;
  if (windowSeconds % 60 === 0) {
    const minutes = windowSeconds / 60;
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"} rolling window`;
  }
  return `${metricNumber.format(windowSeconds / 60)} minute rolling window`;
}

export function metricBucketAccessibleLabel(bucket: MetricsBucket): string {
  const p95 =
    bucket.duration.p95Ms === null
      ? "p95 latency unavailable"
      : `p95 latency ${formatMetricDuration(bucket.duration.p95Ms)}`;
  const errorLabel = bucket.outcomes.error === 1 ? "error" : "errors";
  return `${formatMetricBucketTime(bucket.startedAt)}: ${String(bucket.outcomes.success)} successful, ${String(bucket.outcomes.error)} ${errorLabel}, ${String(bucket.outcomes.cancelled)} cancelled; ${p95}.`;
}

export function sumMetricOutcomes(buckets: readonly MetricsBucket[]): MetricOutcomes {
  return buckets.reduce<MetricOutcomes>(
    (totals, bucket) => ({
      success: totals.success + bucket.outcomes.success,
      error: totals.error + bucket.outcomes.error,
      cancelled: totals.cancelled + bucket.outcomes.cancelled,
    }),
    { success: 0, error: 0, cancelled: 0 },
  );
}

export function sortOperationMetrics(
  operations: readonly OperationMetrics[],
): readonly OperationMetrics[] {
  return operations.toSorted((left, right) => {
    const completedDifference =
      completedMetricCount(right.outcomes) - completedMetricCount(left.outcomes);
    if (completedDifference !== 0) return completedDifference;
    const nameDifference = left.name.localeCompare(right.name);
    if (nameDifference !== 0) return nameDifference;
    return left.role.localeCompare(right.role);
  });
}

export function metricOperationKey(
  operation: Pick<OperationMetrics, "role" | "name" | "kind" | "capability">,
): string {
  return JSON.stringify([
    operation.role,
    operation.name,
    operation.kind,
    operation.capability ?? null,
  ]);
}
