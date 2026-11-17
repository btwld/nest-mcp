"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  History,
  Play,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  getApiErrorMessage,
  type ConformanceReport,
  type ConformanceRun,
  type Connection,
} from "@/lib/control-plane-api";
import {
  cancelConformanceRunMutationOptions,
  conformanceRunQueryOptions,
  conformanceRunsQueryOptions,
  controlPlaneKeys,
  startConformanceRunMutationOptions,
} from "@/lib/control-plane-queries";
import { cn } from "@/lib/utils";

const utcDateTime = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

export function ConnectionConformancePanel({ connection }: { readonly connection: Connection }) {
  const queryClient = useQueryClient();
  const targetKey = `${connection.id}:${String(connection.runtimeGeneration)}`;
  const [selection, setSelection] = useState<{
    readonly targetKey: string;
    readonly runId: string;
  }>();
  const selectedRunId = selection?.targetKey === targetKey ? selection.runId : undefined;
  const runsKey = controlPlaneKeys.conformanceRuns(connection.id, connection.runtimeGeneration);
  const runsQuery = useQuery({
    ...conformanceRunsQueryOptions(connection),
    enabled: !connection.deletionPending,
  });
  const listedActiveRun = runsQuery.data?.find(isActiveRun);
  const detailRunId = listedActiveRun?.runId ?? selectedRunId;
  const detailQuery = useQuery(conformanceRunQueryOptions(detailRunId));
  const detailRun = detailQuery.data;
  const detailTerminal = detailRun !== undefined && !isActiveRun(detailRun);

  useEffect(() => {
    if (!detailTerminal) return;
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: controlPlaneKeys.conformanceRuns(connection.id, connection.runtimeGeneration),
    });
  }, [
    connection.id,
    connection.runtimeGeneration,
    detailRun?.finishedAt,
    detailTerminal,
    queryClient,
  ]);

  const startMutation = useMutation({
    ...startConformanceRunMutationOptions(),
    onSuccess: (run) => {
      setSelection({ targetKey, runId: run.runId });
      queryClient.setQueryData(controlPlaneKeys.conformanceRun(run.runId), run);
      queryClient.setQueryData<ConformanceRun[]>(runsKey, (current) => mergeRun(current, run));
      toast.success("Conformance run queued", { description: "Safe discovery checks only." });
    },
    onError: (error) =>
      toast.error("Could not start conformance run", { description: getApiErrorMessage(error) }),
  });
  const cancelMutation = useMutation({
    ...cancelConformanceRunMutationOptions(),
    onSuccess: (run) => {
      queryClient.setQueryData(controlPlaneKeys.conformanceRun(run.runId), run);
      queryClient.setQueryData<ConformanceRun[]>(runsKey, (current) => mergeRun(current, run));
      toast.success("Conformance cancellation requested");
    },
    onError: (error) =>
      toast.error("Could not cancel conformance run", { description: getApiErrorMessage(error) }),
  });

  const runs = mergeRun(runsQuery.data, detailRun);
  const latest = detailRun ?? runs[0];
  const active = detailRun !== undefined && isActiveRun(detailRun) ? detailRun : listedActiveRun;
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const runDisabledReason = connection.deletionPending
    ? "This connection is being deleted."
    : !runtimeReady
      ? "Connect this runtime before running conformance checks."
      : active !== undefined
        ? "A conformance run is already active for this generation."
        : undefined;

  return (
    <section
      aria-labelledby="conformance-heading"
      className="mb-5 rounded-xl border border-info/20 bg-info/5 p-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 text-info" />
            <h3 className="text-sm font-medium" id="conformance-heading">
              Repeatable conformance
            </h3>
            <Badge variant="outline">safe-discovery-v1</Badge>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Runs bounded, read-only checks against generation {String(connection.runtimeGeneration)}
            and keeps the last five reports in this validation host.
          </p>
        </div>
        <Button
          disabled={runDisabledReason !== undefined}
          loading={startMutation.isPending}
          loadingText="Queuing…"
          onClick={() => startMutation.mutate(connection)}
          size="sm"
          title={runDisabledReason}
          type="button"
        >
          <Play /> Run checks
        </Button>
      </div>

      {active ? (
        <ActiveRun
          cancelling={cancelMutation.isPending}
          onCancel={() => cancelMutation.mutate(active.runId)}
          run={active}
        />
      ) : null}

      {runsQuery.isPending ? (
        <div
          aria-busy="true"
          className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner className="size-3.5" /> Loading conformance history…
        </div>
      ) : null}
      {runsQuery.isError ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-background/60 p-3">
          <p className="text-xs text-muted-foreground" role="alert">
            {getApiErrorMessage(runsQuery.error)}
          </p>
          <Button onClick={() => void runsQuery.refetch()} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}

      {latest?.report ? <ReportSummary report={latest.report} /> : null}
      {latest !== undefined && latest.report === undefined && !isActiveRun(latest) ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border bg-background/60 p-3 text-xs">
          <ShieldAlert className="size-4 text-warning-foreground" />
          <span>
            Run {latest.status}
            {latest.errorCode ? ` · ${latest.errorCode}` : " without a report"}.
          </span>
        </div>
      ) : null}

      {runs.length > 0 ? (
        <RunHistory
          onSelect={(runId) => setSelection({ targetKey, runId })}
          runs={runs}
          selectedRunId={latest?.runId}
        />
      ) : runsQuery.isSuccess ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No runs for this runtime generation yet.
        </p>
      ) : null}
    </section>
  );
}

function ActiveRun({
  run,
  cancelling,
  onCancel,
}: {
  readonly run: ConformanceRun;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border bg-background/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Spinner className="size-3.5" />
          <span className="font-medium capitalize">{run.status}</span>
          <span className="truncate text-muted-foreground">Running bounded discovery plan</span>
        </div>
        <Button
          loading={cancelling}
          loadingText="Cancelling…"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Ban /> Cancel
        </Button>
      </div>
      <div
        aria-label="Conformance run progress"
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div className="h-full w-1/2 animate-pulse rounded-full bg-info" />
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Details refresh once per second while the run is active.
      </p>
    </div>
  );
}

function ReportSummary({ report }: { readonly report: ConformanceReport }) {
  return (
    <div className="mt-3 rounded-lg border bg-background/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={report.verdict} />
          <span className="text-xs text-muted-foreground">
            {report.plan.title} · {String(report.durationMs)} ms
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground tabular-nums">
          <span>{String(report.counts.pass)} pass</span>
          <span>·</span>
          <span>{String(report.counts.warn)} warn</span>
          <span>·</span>
          <span>{String(report.counts.fail)} fail</span>
          <span>·</span>
          <span>{String(report.counts.error)} error</span>
          <span>·</span>
          <span>{String(report.counts.skip)} skip</span>
        </div>
      </div>
      <div className="mt-2 grid gap-1.5 md:grid-cols-2">
        {report.checks.map((check) => (
          <div
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border px-2.5 py-2"
            key={check.id}
          >
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium">{check.title}</p>
              <p className="truncate font-mono text-[9px] text-muted-foreground">{check.code}</p>
            </div>
            <CheckStatusBadge status={check.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RunHistory({
  runs,
  selectedRunId,
  onSelect,
}: {
  readonly runs: readonly ConformanceRun[];
  readonly selectedRunId: string | undefined;
  readonly onSelect: (runId: string) => void;
}) {
  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <History className="size-3.5" /> Current-generation history
      </div>
      <div className="flex flex-wrap gap-1.5">
        {runs.slice(0, 5).map((run) => (
          <button
            aria-pressed={run.runId === selectedRunId}
            className={cn(
              "rounded-md border bg-background/60 px-2 py-1 text-left text-[10px] transition-colors hover:bg-muted",
              run.runId === selectedRunId && "border-info/45 bg-info/5",
            )}
            key={run.runId}
            onClick={() => onSelect(run.runId)}
            type="button"
          >
            <span className="font-medium">{run.report?.verdict ?? run.status}</span>
            <span className="ml-1 text-muted-foreground">
              {utcDateTime.format(new Date(run.createdAt))} UTC
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { readonly verdict: ConformanceReport["verdict"] }) {
  const Icon =
    verdict === "pass" ? CheckCircle2 : verdict === "inconclusive" ? CircleDashed : ShieldAlert;
  return (
    <Badge
      variant={
        verdict === "pass"
          ? "success"
          : verdict === "warn"
            ? "warning"
            : verdict === "fail"
              ? "destructive"
              : "outline"
      }
    >
      <Icon className="size-3" /> {verdict}
    </Badge>
  );
}

function CheckStatusBadge({
  status,
}: {
  readonly status: ConformanceReport["checks"][number]["status"];
}) {
  return (
    <Badge
      variant={
        status === "pass"
          ? "success"
          : status === "warn"
            ? "warning"
            : status === "fail" || status === "error"
              ? "destructive"
              : "outline"
      }
    >
      {status}
    </Badge>
  );
}

function isActiveRun(run: ConformanceRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "cancelling";
}

function mergeRun(
  current: readonly ConformanceRun[] | undefined,
  candidate: ConformanceRun | undefined,
): ConformanceRun[] {
  if (candidate === undefined) return current === undefined ? [] : [...current];
  return [candidate, ...(current ?? []).filter((run) => run.runId !== candidate.runId)]
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 5);
}
