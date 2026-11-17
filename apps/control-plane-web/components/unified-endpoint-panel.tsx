"use client";

import { Clipboard, Network, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { getApiErrorMessage, type Hub } from "@/lib/control-plane-api";

export function UnifiedEndpointPanel({
  snapshot,
  loading,
  error,
  actionsDisabled,
  refreshPending,
  onRetry,
  onRefresh,
}: {
  readonly snapshot: Hub | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly actionsDisabled: boolean;
  readonly refreshPending: boolean;
  readonly onRetry: () => void;
  readonly onRefresh: () => Promise<void>;
}) {
  return (
    <section aria-labelledby="unified-endpoint-heading" className="mt-6">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" id="unified-endpoint-heading">
            Unified MCP endpoint
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One address for the MCPs you choose to make available
          </p>
        </div>
        {error && snapshot ? (
          <Badge className="gap-1" variant="warning">
            <ShieldAlert className="size-3" /> Update delayed
          </Badge>
        ) : null}
      </div>

      <div aria-atomic="true" aria-live="polite" role="status">
        {error && snapshot ? (
          <p className="mb-2 text-xs text-warning-foreground">
            Showing the last known endpoint status. {getApiErrorMessage(error)}
          </p>
        ) : null}
      </div>

      {loading && !snapshot ? (
        <Card className="grid min-h-24 place-items-center border-dashed bg-card/55">
          <div aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading unified MCP endpoint…
          </div>
        </Card>
      ) : null}
      {!loading && !snapshot ? (
        <Card className="flex flex-col items-start gap-4 border-destructive/20 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3" role="alert">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium">Unified MCP endpoint unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">{getApiErrorMessage(error)}</p>
            </div>
          </div>
          <Button onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        </Card>
      ) : null}
      {snapshot ? (
        <Card className="flex flex-col gap-4 bg-card/75 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
              <Network className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <code className="truncate text-sm font-semibold">{snapshot.endpoint.path}</code>
                <Button
                  onClick={() => void copyEndpoint(snapshot.endpoint.path)}
                  size="icon-sm"
                  title="Copy unified MCP endpoint path"
                  variant="ghost"
                >
                  <Clipboard />
                  <span className="sr-only">Copy unified MCP endpoint path</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Add or remove an MCP from its MCP card.
              </p>
              <div aria-label="Published capability counts" className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline">{formatCount(snapshot.counts.tools, "tool")}</Badge>
                <Badge variant="outline">
                  {formatCount(snapshot.counts.resources, "resource")}
                </Badge>
                <Badge variant="outline">
                  {formatCount(snapshot.counts.resourceTemplates, "template")}
                </Badge>
                <Badge variant="outline">{formatCount(snapshot.counts.prompts, "prompt")}</Badge>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={snapshot.members.length > 0 ? "success" : "outline"}>
              {snapshot.members.length} MCP{snapshot.members.length === 1 ? "" : "s"} available
            </Badge>
            <Button
              disabled={actionsDisabled}
              loading={refreshPending}
              loadingText="Refreshing…"
              onClick={() => void onRefresh().catch(() => undefined)}
              size="sm"
              variant="outline"
            >
              <RefreshCw />
              Refresh endpoint capabilities
            </Button>
          </div>
        </Card>
      ) : null}
    </section>
  );
}

async function copyEndpoint(endpoint: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(endpoint);
    toast.success("MCP endpoint copied", { description: endpoint });
  } catch {
    toast.error("Could not copy the MCP endpoint");
  }
}

function formatCount(value: number, singular: string): string {
  return `${String(value)} ${singular}${value === 1 ? "" : "s"}`;
}
