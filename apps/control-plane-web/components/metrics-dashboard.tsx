import { Activity, CircleCheck, Clock3, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Horizontally scrollable regions must remain keyboard focusable. */
import {
  getApiErrorMessage,
  type MetricOutcomes,
  type MetricsBucket,
  type MetricsSnapshot,
} from "@/lib/control-plane-api";
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
} from "@/lib/metrics";
import { cn } from "@/lib/utils";

const utcDateTime = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function MetricsDashboard({
  snapshot,
  loading,
  error,
  onRetry,
}: {
  readonly snapshot: MetricsSnapshot | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onRetry: () => void;
}) {
  return (
    <section aria-labelledby="metrics-heading" className="mt-6">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold" id="metrics-heading">
            MCP operation metrics
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {snapshot ? (
              <>
                In memory since{" "}
                <time dateTime={snapshot.startedAt}>{formatTime(snapshot.startedAt)}</time>
                {" · resets when API restarts"}
              </>
            ) : (
              "Process-local activity and latency"
            )}
          </p>
        </div>
        {error && snapshot ? (
          <Badge className="gap-1" variant="warning">
            <TriangleAlert className="size-3" /> Update delayed
          </Badge>
        ) : snapshot ? (
          <Badge variant="outline">
            {formatMetricWindow(snapshot.window.bucketSeconds, snapshot.window.buckets.length)}
          </Badge>
        ) : null}
      </div>

      <div aria-atomic="true" aria-live="polite" role="status">
        {error && snapshot ? (
          <p className="mb-3 text-xs text-warning-foreground">
            Showing the last valid capture from {formatTime(snapshot.capturedAt)}.{" "}
            {getApiErrorMessage(error)}
          </p>
        ) : null}
      </div>

      {loading && !snapshot ? <MetricsLoading /> : null}
      {!loading && !snapshot ? <MetricsError error={error} onRetry={onRetry} /> : null}
      {snapshot ? <MetricsContent snapshot={snapshot} /> : null}
    </section>
  );
}

function MetricsContent({ snapshot }: { readonly snapshot: MetricsSnapshot }) {
  const completed = completedMetricCount(snapshot.totals.outcomes);
  const successRate = metricSuccessRate(snapshot.totals.outcomes);
  const failureCount = snapshot.totals.outcomes.error + snapshot.totals.outcomes.cancelled;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          detail={`${String(snapshot.totals.started)} started since API boot`}
          icon={<CircleCheck />}
          label="Completed"
          value={String(completed)}
        />
        <SummaryCard
          alert={failureCount > 0}
          detail={`${String(snapshot.totals.outcomes.error)} errors · ${String(snapshot.totals.outcomes.cancelled)} cancelled`}
          icon={<ShieldCheck />}
          label="Success rate"
          value={formatMetricPercent(successRate)}
        />
        <SummaryCard
          detail="Operations currently in flight"
          icon={<Activity />}
          label="Active operations"
          value={String(snapshot.totals.active)}
        />
        <SummaryCard
          detail={`${String(snapshot.totals.duration.count)} latency samples`}
          icon={<Clock3 />}
          label="P95 latency"
          value={formatMetricDuration(snapshot.totals.duration.p95Ms)}
        />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <OutcomeChart buckets={snapshot.window.buckets} />
        <LatencyChart buckets={snapshot.window.buckets} />
      </div>

      <OperationBreakdown snapshot={snapshot} />
    </>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  detail,
  alert = false,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly alert?: boolean;
}) {
  return (
    <Card className={cn("min-w-0 bg-card/75 p-4", alert && "border-warning/35 bg-warning/5")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-4",
            alert && "bg-warning/15 text-warning-foreground",
          )}
        >
          {icon}
        </div>
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
    </Card>
  );
}

function OutcomeChart({ buckets }: { readonly buckets: readonly MetricsBucket[] }) {
  const windowOutcomes = sumMetricOutcomes(buckets);
  const completedByBucket = buckets.map((bucket) => completedMetricCount(bucket.outcomes));
  const maximum = Math.max(0, ...completedByBucket);

  return (
    <Card className="min-w-0 bg-card/75 p-4">
      <figure>
        <figcaption>
          <h3 className="text-sm font-medium">Outcomes over time</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Terminal operations in each process-memory bucket
          </p>
        </figcaption>
        <OutcomeLegend outcomes={windowOutcomes} />
        {maximum === 0 ? (
          <ChartEmpty>No completed MCP operations in this window.</ChartEmpty>
        ) : (
          <div
            aria-label="Scrollable operation outcome chart"
            className="mt-4 overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            tabIndex={0}
          >
            <ol
              aria-label="Operation outcome buckets"
              className="flex h-40 min-w-[36rem] items-end gap-1.5 border-b"
            >
              {buckets.map((bucket) => {
                const completed = completedMetricCount(bucket.outcomes);
                return (
                  <li className="flex h-full min-w-2 flex-1 items-end" key={bucket.startedAt}>
                    <span className="sr-only">{metricBucketAccessibleLabel(bucket)}</span>
                    <div
                      aria-hidden="true"
                      className={cn(
                        "flex w-full flex-col-reverse overflow-hidden rounded-t-sm bg-muted",
                        completed > 0 && "min-h-1",
                      )}
                      style={{ height: `${String(metricChartPercent(completed, maximum))}%` }}
                    >
                      <OutcomeSegment
                        className="bg-success"
                        count={bucket.outcomes.success}
                        total={completed}
                      />
                      <OutcomeSegment
                        className="bg-destructive"
                        count={bucket.outcomes.error}
                        total={completed}
                      />
                      <OutcomeSegment
                        className="bg-warning"
                        count={bucket.outcomes.cancelled}
                        total={completed}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
            <ChartTimeRange buckets={buckets} />
          </div>
        )}
      </figure>
    </Card>
  );
}

function OutcomeSegment({
  count,
  total,
  className,
}: {
  readonly count: number;
  readonly total: number;
  readonly className: string;
}) {
  return (
    <span
      className={cn("w-full", className)}
      style={{ height: `${String(metricChartPercent(count, total))}%` }}
    />
  );
}

function OutcomeLegend({ outcomes }: { readonly outcomes: MetricOutcomes }) {
  const items = [
    { label: "Success", value: outcomes.success, className: "bg-success" },
    { label: "Error", value: outcomes.error, className: "bg-destructive" },
    { label: "Cancelled", value: outcomes.cancelled, className: "bg-warning" },
  ] as const;
  return (
    <ul aria-label="Outcome totals" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
      {items.map((item) => (
        <li className="flex items-center gap-1.5" key={item.label}>
          <span aria-hidden="true" className={cn("size-2 rounded-sm", item.className)} />
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium tabular-nums">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

function LatencyChart({ buckets }: { readonly buckets: readonly MetricsBucket[] }) {
  const hasSamples = buckets.some((bucket) => bucket.duration.count > 0);
  const maximum = Math.max(0, ...buckets.map((bucket) => bucket.duration.p95Ms ?? 0));
  return (
    <Card className="min-w-0 bg-card/75 p-4">
      <figure>
        <figcaption className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">P95 latency</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bounded histogram estimate per bucket
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            Max {formatMetricDuration(hasSamples ? maximum : null)}
          </span>
        </figcaption>
        {!hasSamples ? (
          <ChartEmpty>No latency samples in this window.</ChartEmpty>
        ) : (
          <div
            aria-label="Scrollable latency chart"
            className="mt-4 overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            tabIndex={0}
          >
            <ol
              aria-label="P95 latency buckets"
              className="flex h-48 min-w-[36rem] items-end gap-1.5 border-b"
            >
              {buckets.map((bucket) => {
                const p95 = bucket.duration.p95Ms;
                return (
                  <li className="flex h-full min-w-2 flex-1 items-end" key={bucket.startedAt}>
                    <span className="sr-only">{metricBucketAccessibleLabel(bucket)}</span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-full rounded-t-sm bg-info/80",
                        p95 !== null && p95 > 0 && "min-h-1",
                      )}
                      style={{ height: `${String(metricChartPercent(p95 ?? 0, maximum))}%` }}
                    />
                  </li>
                );
              })}
            </ol>
            <ChartTimeRange buckets={buckets} />
          </div>
        )}
      </figure>
    </Card>
  );
}

function ChartTimeRange({ buckets }: { readonly buckets: readonly MetricsBucket[] }) {
  const first = buckets[0];
  const last = buckets.at(-1);
  if (!first || !last) return null;
  return (
    <div
      aria-hidden="true"
      className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground"
    >
      <time dateTime={first.startedAt}>{formatMetricBucketTime(first.startedAt)}</time>
      <time dateTime={last.startedAt}>{formatMetricBucketTime(last.startedAt)}</time>
    </div>
  );
}

function OperationBreakdown({ snapshot }: { readonly snapshot: MetricsSnapshot }) {
  const operations = sortOperationMetrics(snapshot.operations);
  return (
    <Card className="mt-3 min-w-0 overflow-hidden bg-card/75">
      <div className="flex flex-col gap-2 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-medium">Operation breakdown</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Low-cardinality process totals; raw attributes and targets are excluded
          </p>
        </div>
        {snapshot.operationsTruncated ? (
          <Badge variant="warning">Additional groups omitted</Badge>
        ) : null}
      </div>
      {operations.length === 0 ? (
        <div className="m-4 rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          No operation groups have been observed.
        </div>
      ) : (
        <div
          aria-label="Scrollable MCP operation breakdown"
          className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="region"
          tabIndex={0}
        >
          <table className="w-full min-w-[760px] text-left text-xs">
            <caption className="sr-only">
              MCP operation totals grouped by role, operation name, kind, and capability
            </caption>
            <thead className="bg-muted/35 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium" scope="col">
                  Operation
                </th>
                <th className="px-3 py-2.5 font-medium" scope="col">
                  Runtime
                </th>
                <th className="px-3 py-2.5 text-right font-medium" scope="col">
                  Active
                </th>
                <th className="px-3 py-2.5 text-right font-medium" scope="col">
                  Success
                </th>
                <th className="px-3 py-2.5 text-right font-medium" scope="col">
                  Error
                </th>
                <th className="px-3 py-2.5 text-right font-medium" scope="col">
                  Cancelled
                </th>
                <th className="px-4 py-2.5 text-right font-medium" scope="col">
                  P95
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {operations.map((operation) => (
                <tr key={metricOperationKey(operation)}>
                  <th className="px-4 py-3 font-normal" scope="row">
                    <span className="block font-mono text-[11px] font-medium">
                      {operation.name}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {operation.capability ?? "No capability family"}
                    </span>
                  </th>
                  <td className="px-3 py-3">
                    <Badge variant="mono">{operation.role}</Badge>
                    <span className="ml-2 text-muted-foreground">{operation.kind}</span>
                  </td>
                  <MetricTableNumber>{operation.active}</MetricTableNumber>
                  <MetricTableNumber>{operation.outcomes.success}</MetricTableNumber>
                  <MetricTableNumber>{operation.outcomes.error}</MetricTableNumber>
                  <MetricTableNumber>{operation.outcomes.cancelled}</MetricTableNumber>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMetricDuration(operation.duration.p95Ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t px-4 py-2.5 text-[10px] text-muted-foreground">
        Captured <time dateTime={snapshot.capturedAt}>{formatTime(snapshot.capturedAt)}</time>
      </p>
    </Card>
  );
}

function MetricTableNumber({ children }: { readonly children: number }) {
  return <td className="px-3 py-3 text-right tabular-nums">{children}</td>;
}

function ChartEmpty({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mt-4 grid h-40 place-items-center rounded-lg border border-dashed bg-muted/15 px-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function MetricsLoading() {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">Loading MCP operation metrics.</span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="h-24 animate-pulse rounded-xl border bg-card/55" key={index} />
        ))}
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div className="h-64 animate-pulse rounded-xl border bg-card/55" key={index} />
        ))}
      </div>
    </div>
  );
}

function MetricsError({
  error,
  onRetry,
}: {
  readonly error: Error | null;
  readonly onRetry: () => void;
}) {
  return (
    <Card
      className="flex flex-col items-start gap-4 border-warning/30 bg-warning/5 p-4 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <div className="flex gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
        <div>
          <p className="text-sm font-medium">Metrics snapshot unavailable</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{getApiErrorMessage(error)}</p>
        </div>
      </div>
      <Button onClick={onRetry} size="sm" variant="outline">
        <RefreshCw /> Retry
      </Button>
    </Card>
  );
}

function formatTime(value: string): string {
  return `${utcDateTime.format(new Date(value))} UTC`;
}
