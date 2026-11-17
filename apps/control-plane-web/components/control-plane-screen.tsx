"use client";

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Cable,
  ChevronRight,
  CircleGauge,
  Layers3,
  LockKeyhole,
  Pencil,
  Plus,
  Radar,
  RadioTower,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CatalogPanel } from "@/components/catalog-panel";
import {
  canConnectWithAuthentication,
  ConnectionAuthenticationPanel,
} from "@/components/connection-authentication";
import {
  CreateConnectionDialog,
  DeleteConnectionDialog,
  EditConnectionDialog,
} from "@/components/connection-dialogs";
import { MetricsDashboard } from "@/components/metrics-dashboard";
import { HubCatalogExplorer } from "@/components/hub-catalog-explorer";
import { UnifiedEndpointPanel } from "@/components/unified-endpoint-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  ControlPlaneApiError,
  controlPlaneApi,
  getApiErrorMessage,
  type Connection,
  type ConnectionDraft,
  type ConnectionUpdate,
  type DesiredConnectionState,
  type Hub,
  type HubCatalog,
  type HubMember,
  type RuntimeManager,
  type RuntimePhase,
} from "@/lib/control-plane-api";
import {
  deriveControlPlaneHealthStatus,
  type ControlPlaneHealthStatus,
} from "@/lib/control-plane-health";
import { mergeConnection, mergeObservedRuntime } from "@/lib/connection-cache";
import {
  attachHubMemberMutationOptions,
  connectionPollInterval,
  controlPlaneKeys,
  detachHubMemberMutationOptions,
  hubCatalogQueryOptions,
  hubQueryOptions,
  liveHealthQueryOptions,
  metricsQueryOptions,
  readyHealthQueryOptions,
  refreshHubCatalogMutationOptions,
  runtimePollInterval,
} from "@/lib/control-plane-queries";
import {
  canExposeConnection,
  retainNewestEndpointSnapshot,
  suggestExposureNamespace,
} from "@/lib/hub";
import { parseOAuthCallbackMarker, stripOAuthCallbackMarker } from "@/lib/oauth-callback";
import { cn } from "@/lib/utils";

const utcDateTime = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const capabilityLabels = {
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  completion: "Completion",
  subscriptions: "Subscriptions",
} as const;

const retryableRuntimePhases: ReadonlySet<RuntimePhase> = new Set([
  "degraded",
  "failed",
  "offline",
]);

type DesiredMutationInput = {
  readonly connection: Connection;
  readonly state: DesiredConnectionState;
};

export function ControlPlaneScreen() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const cancelConnectionReads = () =>
    queryClient.cancelQueries({ queryKey: controlPlaneKeys.connections });

  const connectionsQuery = useQuery({
    queryKey: controlPlaneKeys.connections,
    queryFn: ({ signal }) => controlPlaneApi.listConnections(signal),
    refetchInterval: (query) => connectionPollInterval(query.state.data),
  });
  const runtimeQuery = useQuery({
    queryKey: controlPlaneKeys.runtime,
    queryFn: ({ signal }) => controlPlaneApi.runtimeSnapshot(signal),
    refetchInterval: (query) => runtimePollInterval(query.state.data),
  });
  const metricsQuery = useQuery(metricsQueryOptions());
  const hubQuery = useQuery(hubQueryOptions());
  const hubCatalogQuery = useQuery(hubCatalogQueryOptions(hubQuery.data?.revision));
  const liveHealthQuery = useQuery(liveHealthQueryOptions());
  const readyHealthQuery = useQuery(readyHealthQueryOptions());

  useEffect(() => {
    if (
      hubCatalogQuery.error instanceof ControlPlaneApiError &&
      hubCatalogQuery.error.code === "MCP_HUB_REVISION_CONFLICT"
    ) {
      void queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
    }
  }, [hubCatalogQuery.error, queryClient]);

  useEffect(() => {
    const marker = parseOAuthCallbackMarker(window.location.search);
    if (marker === null) return;

    const replacement = stripOAuthCallbackMarker(new URL(window.location.href));
    window.history.replaceState(window.history.state, "", replacement);

    if (marker.outcome === "authorized") {
      toast.success("OAuth authorization completed");
      queryClient.removeQueries({ queryKey: controlPlaneKeys.catalogPrefix(marker.connectionId) });
    } else if (marker.outcome === "failed") {
      toast.error("OAuth authorization failed", {
        description: marker.code
          ? `Error code: ${marker.code}`
          : "Authorization was not completed.",
      });
    } else {
      toast.error("OAuth callback could not be validated");
    }

    void Promise.all([
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub }),
    ]);
  }, [queryClient]);

  const addToEndpointMutation = useMutation({
    ...attachHubMemberMutationOptions(),
    onMutate: () => queryClient.cancelQueries({ queryKey: controlPlaneKeys.hub }),
    onSuccess: async (snapshot, { connection }) => {
      await queryClient.cancelQueries({ queryKey: controlPlaneKeys.hub });
      queryClient.removeQueries({ queryKey: controlPlaneKeys.hubCatalogPrefix });
      setEndpointSnapshotInCache(queryClient, snapshot);
      toast.success("MCP added to unified endpoint", { description: connection.displayName });
    },
    onError: (error) =>
      handleEndpointMutationError(queryClient, "Could not add MCP to endpoint", error),
  });

  const removeFromEndpointMutation = useMutation({
    ...detachHubMemberMutationOptions(),
    onMutate: () => queryClient.cancelQueries({ queryKey: controlPlaneKeys.hub }),
    onSuccess: async (_, { member }) => {
      queryClient.removeQueries({ queryKey: controlPlaneKeys.hubCatalogPrefix });
      await queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
      toast.success("MCP removed from unified endpoint", { description: member.displayName });
    },
    onError: (error) =>
      handleEndpointMutationError(queryClient, "Could not remove MCP from endpoint", error),
  });

  const refreshEndpointMutation = useMutation({
    ...refreshHubCatalogMutationOptions(),
    onMutate: () => queryClient.cancelQueries({ queryKey: controlPlaneKeys.hub }),
    onSuccess: async (snapshot) => {
      await queryClient.cancelQueries({ queryKey: controlPlaneKeys.hub });
      queryClient.removeQueries({ queryKey: controlPlaneKeys.hubCatalogPrefix });
      setEndpointSnapshotInCache(queryClient, snapshot);
      toast.success("Endpoint capabilities refreshed");
    },
    onError: (error) =>
      handleEndpointMutationError(queryClient, "Could not refresh endpoint capabilities", error),
  });

  const createMutation = useMutation({
    mutationFn: ({ draft, connectNow }: { draft: ConnectionDraft; connectNow: boolean }) =>
      controlPlaneApi.createConnection({
        ...draft,
        desiredState:
          draft.authentication.kind === "oauth" ? "offline" : connectNow ? "online" : "offline",
      }),
    onMutate: cancelConnectionReads,
    onSuccess: async (connection) => {
      await cancelConnectionReads();
      setConnectionInCache(queryClient, connection);
      void queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime });
      setSelectedId(connection.id);
      setCreateOpen(false);
      toast.success("MCP added", {
        description:
          connection.authentication.kind === "oauth" &&
          connection.authentication.status !== "authorized"
            ? `${connection.displayName} is offline. Authorize it from its MCP card, then connect.`
            : `${connection.displayName} wants ${connection.desiredState}; runtime is ${connection.runtime.phase}.`,
      });
    },
    onError: (error) => handleMutationError(queryClient, "Could not add MCP", error),
  });

  const editMutation = useMutation({
    mutationFn: ({ connection, draft }: { connection: Connection; draft: ConnectionUpdate }) =>
      controlPlaneApi.replaceConnection(connection.id, connection.revision, draft),
    onMutate: cancelConnectionReads,
    onSuccess: async (connection, { connection: previous }) => {
      await cancelConnectionReads();
      if (connection.runtimeGeneration !== previous.runtimeGeneration) {
        queryClient.removeQueries({ queryKey: controlPlaneKeys.catalogPrefix(connection.id) });
      }
      setConnectionInCache(queryClient, connection);
      void queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime });
      void queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
      setEditing(null);
      toast.success("MCP updated", { description: connection.displayName });
    },
    onError: (error) => handleMutationError(queryClient, "Could not update MCP", error),
  });

  const desiredMutation = useMutation({
    mutationFn: ({ connection, state }: DesiredMutationInput) =>
      controlPlaneApi.setDesiredState(connection.id, connection.revision, state),
    onMutate: cancelConnectionReads,
    onSuccess: async (connection) => {
      await cancelConnectionReads();
      setConnectionInCache(queryClient, connection);
      void queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime });
      void queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
      toast.success(
        connection.desiredState === "online" ? "Connection requested" : "Disconnected",
        {
          description:
            connection.desiredState === "online"
              ? `${connection.displayName} now wants an online runtime.`
              : `${connection.displayName} is now offline.`,
        },
      );
    },
    onError: (error) => handleMutationError(queryClient, "Could not change desired state", error),
  });

  const probeMutation = useMutation({
    mutationFn: (connection: Connection) =>
      controlPlaneApi.probeConnection(connection.id).then((probe) => ({ connection, probe })),
    onMutate: cancelConnectionReads,
    onSuccess: async ({ connection, probe }) => {
      await cancelConnectionReads();
      queryClient.setQueryData<Connection[]>(controlPlaneKeys.connections, (current) =>
        mergeObservedRuntime(current, connection, probe.runtime),
      );
      void queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime });
      toast.success("Endpoint reachable", {
        description: probe.protocolVersion
          ? `Protocol ${probe.protocolVersion} · observed ${formatTime(probe.observedAt)}`
          : `Observed ${formatTime(probe.observedAt)}`,
      });
    },
    onError: (error) => handleMutationError(queryClient, "Probe failed", error),
  });

  const deleteMutation = useMutation({
    mutationFn: (connection: Connection) =>
      controlPlaneApi.deleteConnection(connection.id, connection.revision).then(() => connection),
    onMutate: cancelConnectionReads,
    onSuccess: async (connection) => {
      await cancelConnectionReads();
      queryClient.setQueryData<Connection[]>(controlPlaneKeys.connections, (current) =>
        current?.filter((candidate) => candidate.id !== connection.id),
      );
      queryClient.removeQueries({ queryKey: controlPlaneKeys.catalogPrefix(connection.id) });
      void queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime });
      void queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
      setDeleting(null);
      toast.success("MCP deleted", { description: connection.displayName });
    },
    onError: (error) => handleMutationError(queryClient, "Could not delete MCP", error),
  });

  const connections = connectionsQuery.data ?? [];
  const selectedConnection =
    connections.find((connection) => connection.id === selectedId) ?? connections[0];
  const endpointEntriesByConnectionId = new Map(
    hubQuery.data?.members.map((entry) => [entry.connectionId, entry]) ?? [],
  );
  const endpointMutationPending =
    addToEndpointMutation.isPending ||
    removeFromEndpointMutation.isPending ||
    refreshEndpointMutation.isPending;
  const endpointActionsAvailable =
    hubQuery.data !== undefined && !hubQuery.isFetching && !hubQuery.isError;
  const refreshing =
    connectionsQuery.isFetching ||
    runtimeQuery.isFetching ||
    metricsQuery.isFetching ||
    hubQuery.isFetching ||
    hubCatalogQuery.isFetching ||
    liveHealthQuery.isFetching ||
    readyHealthQuery.isFetching;
  const healthStatus = deriveControlPlaneHealthStatus({
    live: liveHealthQuery.data,
    ready: readyHealthQuery.data,
    liveFailed: liveHealthQuery.isError,
    readyFailed: readyHealthQuery.isError,
  });

  function refreshOverview() {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.metrics }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.healthLive }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.healthReady }),
      queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub }),
      queryClient.invalidateQueries({ queryKey: controlPlaneKeys.hubCatalogPrefix }),
    ]);
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <Header
        healthStatus={healthStatus}
        onAdd={() => setCreateOpen(true)}
        onRefresh={refreshOverview}
        refreshing={refreshing}
      />
      <ValidationHostNotice />
      <RuntimeOverview
        error={runtimeQuery.error}
        loading={runtimeQuery.isPending}
        runtime={runtimeQuery.data}
      />
      <UnifiedEndpointPanel
        actionsDisabled={
          addToEndpointMutation.isPending ||
          removeFromEndpointMutation.isPending ||
          hubQuery.isFetching ||
          hubQuery.isError
        }
        error={hubQuery.error}
        loading={hubQuery.isPending}
        onRefresh={async () => {
          const snapshot = requireEndpointSnapshot(hubQuery.data);
          await refreshEndpointMutation.mutateAsync(snapshot.revision);
        }}
        onRetry={() => void hubQuery.refetch()}
        refreshPending={refreshEndpointMutation.isPending}
        snapshot={hubQuery.data}
      />
      <HubCatalogState
        catalog={hubCatalogQuery.data}
        error={hubCatalogQuery.error}
        loading={hubCatalogQuery.isPending && hubQuery.data !== undefined}
        onRetry={() => void hubCatalogQuery.refetch()}
      />

      {connectionsQuery.isError ? (
        <OverviewError
          error={connectionsQuery.error}
          onRetry={() => void connectionsQuery.refetch()}
        />
      ) : null}

      {connectionsQuery.isPending ? <ConnectionsLoading /> : null}

      {connectionsQuery.isSuccess && connections.length === 0 ? (
        <EmptyConnections onAdd={() => setCreateOpen(true)} />
      ) : null}

      {connections.length > 0 ? (
        <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(350px,0.85fr)_minmax(0,1.65fr)]">
          <section aria-labelledby="connections-heading" className="min-w-0">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold" id="connections-heading">
                  Managed MCP servers
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {connections.length} configured
                </p>
              </div>
              <Badge variant="outline">Validation inventory</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              {connections.map((connection) => (
                <ConnectionCard
                  connection={connection}
                  desiredPendingState={
                    desiredMutation.isPending &&
                    desiredMutation.variables.connection.id === connection.id
                      ? desiredMutation.variables.state
                      : null
                  }
                  endpointActionPending={
                    addToEndpointMutation.isPending &&
                    addToEndpointMutation.variables.connection.id === connection.id
                      ? "adding"
                      : removeFromEndpointMutation.isPending &&
                          removeFromEndpointMutation.variables.member.connectionId === connection.id
                        ? "removing"
                        : null
                  }
                  endpointActionsAvailable={endpointActionsAvailable}
                  endpointEntry={currentEndpointEntry(
                    endpointEntriesByConnectionId.get(connection.id),
                    connection,
                  )}
                  endpointMutationPending={endpointMutationPending}
                  endpointStatusAvailable={hubQuery.data !== undefined}
                  key={connection.id}
                  onAddToEndpoint={() => {
                    const snapshot = requireEndpointSnapshot(hubQuery.data);
                    addToEndpointMutation.mutate({
                      connection,
                      hubRevision: snapshot.revision,
                      namespace: suggestExposureNamespace(connection.displayName, snapshot.members),
                    });
                  }}
                  onDelete={() => setDeleting(connection)}
                  onDesiredState={(state) => desiredMutation.mutate({ connection, state })}
                  onEdit={() => setEditing(connection)}
                  onRemoveFromEndpoint={() => {
                    const snapshot = requireEndpointSnapshot(hubQuery.data);
                    const entry = endpointEntriesByConnectionId.get(connection.id);
                    if (entry === undefined) return;
                    removeFromEndpointMutation.mutate({
                      hubRevision: snapshot.revision,
                      member: entry,
                    });
                  }}
                  onProbe={() => probeMutation.mutate(connection)}
                  onSelect={() => setSelectedId(connection.id)}
                  probePending={
                    probeMutation.isPending && probeMutation.variables.id === connection.id
                  }
                  selected={selectedConnection?.id === connection.id}
                />
              ))}
            </div>
          </section>
          <Card className="min-w-0 bg-card/80 p-4 shadow-sm sm:p-5 lg:p-6">
            {selectedConnection ? (
              <CatalogPanel
                connection={selectedConnection}
                key={`${selectedConnection.id}:${String(selectedConnection.runtimeGeneration)}`}
              />
            ) : null}
          </Card>
        </div>
      ) : null}

      <MetricsDashboard
        error={metricsQuery.error}
        loading={metricsQuery.isPending}
        onRetry={() => void metricsQuery.refetch()}
        snapshot={metricsQuery.data}
      />

      {createOpen ? (
        <CreateConnectionDialog
          onDismiss={() => setCreateOpen(false)}
          onSubmit={async (draft, connectNow) => {
            await createMutation.mutateAsync({ draft, connectNow });
          }}
          pending={createMutation.isPending}
        />
      ) : null}
      {editing ? (
        <EditConnectionDialog
          connection={editing}
          key={`${editing.id}:${String(editing.revision)}`}
          onDismiss={() => setEditing(null)}
          onSubmit={async (draft) => {
            await editMutation.mutateAsync({ connection: editing, draft });
          }}
          pending={editMutation.isPending}
        />
      ) : null}
      {deleting ? (
        <DeleteConnectionDialog
          connection={deleting}
          key={`${deleting.id}:${String(deleting.revision)}`}
          onConfirm={async () => {
            await deleteMutation.mutateAsync(deleting);
          }}
          onDismiss={() => setDeleting(null)}
          pending={deleteMutation.isPending}
        />
      ) : null}
    </main>
  );
}

function HubCatalogState({
  catalog,
  loading,
  error,
  onRetry,
}: {
  readonly catalog: HubCatalog | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onRetry: () => void;
}) {
  if (catalog) {
    return (
      <div className="mt-3">
        <HubCatalogExplorer catalog={catalog} />
      </div>
    );
  }
  if (loading) {
    return (
      <Card className="mt-3 grid min-h-36 place-items-center border-dashed bg-card/55">
        <div aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading projected Hub catalog…
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="mt-3 flex flex-col items-start gap-4 border-warning/30 bg-warning/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3" role="alert">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
          <div>
            <p className="text-sm font-medium">Projected Hub catalog unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">{getApiErrorMessage(error)}</p>
          </div>
        </div>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </Card>
    );
  }
  return null;
}

function Header({
  healthStatus,
  refreshing,
  onRefresh,
  onAdd,
}: {
  readonly healthStatus: ControlPlaneHealthStatus;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onAdd: () => void;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="relative grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/15">
          <ServerCog className="size-5" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background",
              healthStatus === "ready" && "bg-success",
              healthStatus === "checking" && "animate-pulse bg-info",
              healthStatus === "not-ready" && "bg-warning",
              healthStatus === "unreachable" && "bg-destructive",
            )}
          />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">MCP Manager</h1>
            <HealthBadge status={healthStatus} />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Managed MCP servers, health, and capabilities
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button loading={refreshing} onClick={onRefresh} size="sm" variant="outline">
          <RefreshCw />
          Refresh
        </Button>
        <Button onClick={onAdd} size="sm">
          <Plus />
          Add MCP
        </Button>
      </div>
    </header>
  );
}

function HealthBadge({ status }: { readonly status: ControlPlaneHealthStatus }) {
  if (status === "ready") {
    return (
      <Badge className="gap-1" variant="success">
        <Activity className="size-3" /> API ready
      </Badge>
    );
  }
  if (status === "not-ready") {
    return (
      <Badge className="gap-1" variant="warning">
        <ShieldAlert className="size-3" /> API not ready
      </Badge>
    );
  }
  if (status === "unreachable") {
    return (
      <Badge className="gap-1" variant="destructive">
        <Unplug className="size-3" /> API unreachable
      </Badge>
    );
  }
  return (
    <Badge className="gap-1" variant="outline">
      <Spinner className="size-3" /> Checking API
    </Badge>
  );
}

function ValidationHostNotice() {
  return (
    <div className="mb-6 flex items-start gap-2 rounded-lg border border-info/20 bg-info/5 px-3 py-2.5 text-xs text-muted-foreground">
      <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-info" />
      <p>
        <span className="font-medium text-foreground">Volatile validation host.</span> Connections,
        OAuth state, unified-endpoint membership, catalogs, conformance reports, and metrics reset
        when the API restarts. Administrative access is enforced by the deployment boundary, not
        this UI.
      </p>
    </div>
  );
}

function RuntimeOverview({
  runtime,
  loading,
  error,
}: {
  readonly runtime: RuntimeManager | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="h-24 animate-pulse rounded-xl border bg-card/55" key={index} />
        ))}
      </div>
    );
  }
  if (error || !runtime) {
    return (
      <Card className="flex items-center gap-3 border-warning/30 bg-warning/5 p-4 text-sm">
        <ShieldAlert className="size-5 text-warning-foreground" />
        <div>
          <p className="font-medium">Runtime snapshot unavailable</p>
          <p className="text-xs text-muted-foreground">{getApiErrorMessage(error)}</p>
        </div>
      </Card>
    );
  }

  const utilization = Math.min(100, (runtime.connectionCount / runtime.maxConnections) * 100);
  return (
    <section aria-label="Runtime capacity" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard
        detail={`${String(runtime.maxConnections)} maximum`}
        icon={<CircleGauge />}
        label="Capacity used"
        value={`${String(runtime.connectionCount)} / ${String(runtime.maxConnections)}`}
      >
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              utilization >= 90 ? "bg-warning" : "bg-info",
            )}
            style={{ width: `${String(utilization)}%` }}
          />
        </div>
      </MetricCard>
      <MetricCard
        detail={`${String(runtime.onlineKeeperCount)} desired online`}
        icon={<Activity />}
        label="Active runtimes"
        value={String(runtime.activeConnectionCount)}
      />
      <MetricCard
        detail={`${String(runtime.operationReferenceCount)} operation references`}
        icon={<Layers3 />}
        label="Pending / closing"
        value={`${String(runtime.pendingConnectionCount)} / ${String(runtime.closingConnectionCount)}`}
      />
      <MetricCard
        alert={runtime.quarantinedConnectionCount > 0 || runtime.closed}
        detail={runtime.closed ? "Manager is closed" : "Capacity held after cleanup failure"}
        icon={<ShieldAlert />}
        label="Quarantined"
        value={String(runtime.quarantinedConnectionCount)}
      />
    </section>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  alert = false,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly alert?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <Card className={cn("min-w-0 bg-card/75 p-4", alert && "border-warning/35 bg-warning/5")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        </div>
        <div
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-4",
            alert && "bg-warning/15 text-warning-foreground",
          )}
        >
          {icon}
        </div>
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
      <p className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
    </Card>
  );
}

function ConnectionCard({
  connection,
  selected,
  desiredPendingState,
  probePending,
  endpointEntry,
  endpointActionsAvailable,
  endpointStatusAvailable,
  endpointMutationPending,
  endpointActionPending,
  onSelect,
  onDesiredState,
  onProbe,
  onEdit,
  onDelete,
  onAddToEndpoint,
  onRemoveFromEndpoint,
}: {
  readonly connection: Connection;
  readonly selected: boolean;
  readonly desiredPendingState: DesiredConnectionState | null;
  readonly probePending: boolean;
  readonly endpointEntry: HubMember | undefined;
  readonly endpointActionsAvailable: boolean;
  readonly endpointStatusAvailable: boolean;
  readonly endpointMutationPending: boolean;
  readonly endpointActionPending: "adding" | "removing" | null;
  readonly onSelect: () => void;
  readonly onDesiredState: (state: DesiredConnectionState) => void;
  readonly onProbe: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onAddToEndpoint: () => void;
  readonly onRemoveFromEndpoint: () => void;
}) {
  const toolCallPending =
    useIsMutating({ mutationKey: controlPlaneKeys.toolCall(connection.id) }) > 0;
  const resourceReadPending =
    useIsMutating({ mutationKey: controlPlaneKeys.resourceRead(connection.id) }) > 0;
  const promptGetPending =
    useIsMutating({ mutationKey: controlPlaneKeys.promptGet(connection.id) }) > 0;
  const capabilities = connection.runtime.capabilities;
  const activeCapabilities = capabilities
    ? (Object.keys(capabilityLabels) as (keyof typeof capabilityLabels)[]).filter(
        (key) => capabilities[key],
      )
    : [];
  const disabled = connection.deletionPending;
  const busy =
    desiredPendingState !== null ||
    probePending ||
    toolCallPending ||
    resourceReadPending ||
    promptGetPending ||
    endpointActionPending !== null;
  const canAddToEndpoint = canExposeConnection(connection);
  const retryable =
    connection.desiredState === "online" && retryableRuntimePhases.has(connection.runtime.phase);
  const canConnect = canConnectWithAuthentication(connection.authentication);
  const requestedState: DesiredConnectionState = retryable
    ? "online"
    : connection.desiredState === "online"
      ? "offline"
      : "online";
  return (
    <Card
      className={cn(
        "min-w-0 overflow-hidden bg-card/75 transition-[border-color,box-shadow,transform]",
        selected && "border-info/45 shadow-sm ring-2 ring-info/8",
      )}
    >
      <div className="p-4">
        <div className="flex items-start gap-2">
          <button
            aria-current={selected ? "true" : undefined}
            className="group min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            onClick={onSelect}
            type="button"
          >
            <div className="flex items-center gap-2">
              <PhaseDot phase={connection.runtime.phase} />
              <h3 className="truncate text-sm font-semibold group-hover:text-info">
                {connection.displayName}
              </h3>
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  selected && "translate-x-0.5 text-info",
                )}
              />
            </div>
            <p className="mt-1.5 truncate pl-4 font-mono text-[11px] text-muted-foreground">
              {connection.transport.host}
            </p>
          </button>
          <div className="flex shrink-0 items-center">
            <Button
              disabled={disabled || busy}
              onClick={onEdit}
              size="icon-sm"
              title="Edit"
              variant="ghost"
            >
              <Pencil />
              <span className="sr-only">Edit {connection.displayName}</span>
            </Button>
            <Button
              disabled={disabled || busy}
              onClick={onDelete}
              size="icon-sm"
              title="Delete"
              variant="ghost"
            >
              <Trash2 />
              <span className="sr-only">Delete {connection.displayName}</span>
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <PhaseBadge phase={connection.runtime.phase} />
          <Badge variant={connection.desiredState === "online" ? "info" : "outline"}>
            wants {connection.desiredState}
          </Badge>
        </div>

        <div className="mt-3 min-h-6">
          {activeCapabilities.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {activeCapabilities.map((capability) => (
                <span
                  className="rounded-md bg-muted px-1.5 py-1 text-[10px] font-medium text-muted-foreground"
                  key={capability}
                >
                  {capabilityLabels[capability]}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">Capabilities not observed</span>
          )}
        </div>

        {connection.runtime.errorCode ? (
          <p className="mt-2 truncate rounded-md bg-destructive/7 px-2 py-1.5 font-mono text-[10px] text-destructive">
            {connection.runtime.errorCode}
          </p>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-[10px] text-muted-foreground">
          <span>Transition {formatTime(connection.runtime.lastTransitionAt)}</span>
          <span className="text-right">
            {connection.runtime.protocolEra ?? "Protocol unknown"}
            {connection.runtime.protocolVersion ? ` · ${connection.runtime.protocolVersion}` : ""}
          </span>
        </div>

        <ConnectionAuthenticationPanel connection={connection} disabled={disabled || busy} />

        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/25 p-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <RadioTower
              className={cn(
                "size-4 shrink-0",
                endpointEntry ? "text-success" : "text-muted-foreground",
              )}
            />
            <p aria-live="polite" className="text-[11px] leading-snug text-muted-foreground">
              {endpointActionPending === "adding"
                ? "Adding to unified MCP endpoint…"
                : endpointActionPending === "removing"
                  ? "Removing from unified MCP endpoint…"
                  : endpointEntry
                    ? "Available through unified MCP endpoint"
                    : !endpointStatusAvailable
                      ? "Unified endpoint status unavailable"
                      : !endpointActionsAvailable
                        ? "Unified endpoint status is updating"
                        : !canAddToEndpoint
                          ? "Connect this MCP to add it to the unified endpoint"
                          : "Not available through unified MCP endpoint"}
            </p>
          </div>
          {endpointEntry ? (
            <Button
              aria-label={`Remove ${connection.displayName} from unified MCP endpoint`}
              disabled={disabled || endpointMutationPending || busy}
              loading={endpointActionPending === "removing"}
              loadingText="Removing…"
              onClick={onRemoveFromEndpoint}
              size="sm"
              variant="outline"
            >
              Remove
            </Button>
          ) : (
            <Button
              aria-label={`Add ${connection.displayName} to unified MCP endpoint`}
              disabled={
                disabled ||
                endpointMutationPending ||
                busy ||
                !endpointStatusAvailable ||
                !endpointActionsAvailable ||
                !canAddToEndpoint
              }
              loading={endpointActionPending === "adding"}
              loadingText="Adding…"
              onClick={onAddToEndpoint}
              size="sm"
              title={
                endpointStatusAvailable && !canAddToEndpoint
                  ? "Connect this MCP before adding it to the unified endpoint."
                  : undefined
              }
            >
              Add
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t bg-muted/30 p-2.5">
        <Button
          className="flex-1"
          disabled={disabled || busy || (requestedState === "online" && !canConnect)}
          loading={desiredPendingState === "online"}
          onClick={() => onDesiredState(requestedState)}
          size="sm"
          title={
            requestedState === "online" && !canConnect
              ? "Authorize this MCP with OAuth before connecting."
              : undefined
          }
          variant={connection.desiredState === "online" ? "outline" : "secondary"}
        >
          {retryable ? (
            <RefreshCw />
          ) : connection.desiredState === "online" ? (
            <Unplug />
          ) : (
            <Cable />
          )}
          {retryable
            ? "Retry runtime"
            : connection.desiredState === "online"
              ? "Disconnect"
              : "Connect"}
        </Button>
        {retryable ? (
          <Button
            disabled={disabled || busy}
            loading={desiredPendingState === "offline"}
            onClick={() => onDesiredState("offline")}
            size="sm"
            variant="ghost"
          >
            <Unplug />
            Offline
          </Button>
        ) : null}
        <Button
          disabled={disabled || desiredPendingState !== null || !canConnect}
          loading={probePending}
          onClick={onProbe}
          size="sm"
          title={
            !canConnect ? "Authorize this MCP with OAuth before probing its runtime." : undefined
          }
          variant="ghost"
        >
          <Radar />
          Probe
        </Button>
      </div>
    </Card>
  );
}

function PhaseDot({ phase }: { readonly phase: RuntimePhase }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        phase === "online" && "bg-success shadow-[0_0_0_3px_oklch(0.49_0.13_151/0.12)]",
        (phase === "queued" || phase === "connecting" || phase === "draining") &&
          "animate-pulse bg-info",
        phase === "degraded" && "animate-pulse bg-warning",
        (phase === "failed" || phase === "quarantined") && "bg-destructive",
        phase === "offline" && "bg-muted-foreground/50",
      )}
    />
  );
}

function PhaseBadge({ phase }: { readonly phase: RuntimePhase }) {
  const variant =
    phase === "online"
      ? "success"
      : phase === "degraded"
        ? "warning"
        : phase === "failed" || phase === "quarantined"
          ? "destructive"
          : phase === "queued" || phase === "connecting" || phase === "draining"
            ? "info"
            : "secondary";
  return <Badge variant={variant}>{phase}</Badge>;
}

function OverviewError({
  error,
  onRetry,
}: {
  readonly error: Error;
  readonly onRetry: () => void;
}) {
  return (
    <Card className="mt-6 flex flex-col items-start gap-4 border-destructive/20 bg-destructive/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div>
          <h2 className="text-sm font-medium">Could not load MCP servers</h2>
          <p className="mt-1 text-xs text-muted-foreground">{getApiErrorMessage(error)}</p>
        </div>
      </div>
      <Button onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </Card>
  );
}

function ConnectionsLoading() {
  return (
    <Card className="mt-6 grid min-h-64 place-items-center border-dashed bg-card/55">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading MCP servers…
      </div>
    </Card>
  );
}

function EmptyConnections({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <Card className="mt-6 grid min-h-80 place-items-center border-dashed bg-card/60 p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground">
          <Cable className="size-5" />
        </div>
        <h2 className="mt-4 font-semibold">Add your first MCP</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Register an HTTP MCP server, connect it, and inspect its tools, resources, templates, and
          prompts.
        </p>
        <Button className="mt-5" onClick={onAdd}>
          <Plus />
          Add MCP
        </Button>
      </div>
    </Card>
  );
}

function setConnectionInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  connection: Connection,
) {
  queryClient.setQueryData<Connection[]>(controlPlaneKeys.connections, (current) =>
    mergeConnection(current, connection),
  );
}

function setEndpointSnapshotInCache(queryClient: ReturnType<typeof useQueryClient>, incoming: Hub) {
  queryClient.setQueryData<Hub>(controlPlaneKeys.hub, (current) =>
    retainNewestEndpointSnapshot(current, incoming),
  );
}

function requireEndpointSnapshot(snapshot: Hub | undefined): Hub {
  if (snapshot === undefined) throw new Error("A current endpoint snapshot is required.");
  return snapshot;
}

function currentEndpointEntry(
  entry: HubMember | undefined,
  connection: Connection,
): HubMember | undefined {
  return entry?.connectionRevision === connection.revision &&
    entry.runtimeGeneration === connection.runtimeGeneration
    ? entry
    : undefined;
}

function handleEndpointMutationError(
  queryClient: ReturnType<typeof useQueryClient>,
  title: string,
  error: unknown,
) {
  void queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub });
  toast.error(title, { description: getEndpointErrorMessage(error) });
}

function getEndpointErrorMessage(error: unknown): string {
  if (error instanceof ControlPlaneApiError) {
    if (error.code === "MCP_HUB_NAMESPACE_CONFLICT") {
      return "Another MCP already uses this endpoint routing label. Refresh and try again.";
    }
    if (error.code === "MCP_HUB_MEMBER_CONFLICT") {
      return "This MCP is already available through the unified endpoint.";
    }
    if (error.code === "MCP_HUB_MEMBER_NOT_FOUND") {
      return "This MCP is no longer available through the unified endpoint.";
    }
    if (error.code === "MCP_HUB_REVISION_CONFLICT") {
      return "The unified endpoint changed. Review its current state and try again.";
    }
    if (error.code === "MCP_HUB_CATALOG_INVALID") {
      return "This MCP's capabilities could not be added safely.";
    }
    if (error.code === "MCP_HUB_CLOSED") {
      return "The unified MCP endpoint is unavailable.";
    }
    if (error.code === "INVALID_RESPONSE") {
      return "The endpoint returned an unexpected status. Refresh and try again.";
    }
  }
  return getApiErrorMessage(error)
    .replace(/\bMCP hub\b/giu, "unified MCP endpoint")
    .replace(/\bhub\b/giu, "endpoint")
    .replace(/\bmembers?\b/giu, "MCP");
}

function handleMutationError(
  queryClient: ReturnType<typeof useQueryClient>,
  title: string,
  error: unknown,
) {
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
    queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
    queryClient.invalidateQueries({ exact: true, queryKey: controlPlaneKeys.hub }),
  ]);
  toast.error(title, { description: getApiErrorMessage(error) });
}

function formatTime(value: string): string {
  return `${utcDateTime.format(new Date(value))} UTC`;
}
