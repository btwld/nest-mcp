import { mutationOptions, queryOptions } from "@tanstack/react-query";

import {
  controlPlaneApi,
  type Connection,
  type ConformanceRun,
  type Hub,
  type HubMember,
  type GetPromptInput,
  type GetPromptResult,
  type ReadResourceInput,
  type ReadResourceResult,
  type RuntimeManager,
  type RuntimePhase,
  type ToolCallInput,
  type ToolCallResult,
} from "./control-plane-api";

export const controlPlaneKeys = {
  all: ["control-plane"] as const,
  connections: ["control-plane", "connections"] as const,
  runtime: ["control-plane", "runtime"] as const,
  metrics: ["control-plane", "metrics"] as const,
  healthLive: ["control-plane", "health", "live"] as const,
  healthReady: ["control-plane", "health", "ready"] as const,
  hub: ["control-plane", "hub"] as const,
  hubCatalog: (hubRevision: number) => ["control-plane", "hub", "catalog", hubRevision] as const,
  hubCatalogPrefix: ["control-plane", "hub", "catalog"] as const,
  hubRefresh: ["control-plane", "hub", "refresh"] as const,
  toolCall: (connectionId: string) => ["control-plane", "tool-call", connectionId] as const,
  resourceRead: (connectionId: string) => ["control-plane", "resource-read", connectionId] as const,
  promptGet: (connectionId: string) => ["control-plane", "prompt-get", connectionId] as const,
  catalog: (connectionId: string, runtimeGeneration: number) =>
    ["control-plane", "catalog", connectionId, runtimeGeneration] as const,
  catalogPrefix: (connectionId: string) => ["control-plane", "catalog", connectionId] as const,
  conformanceRuns: (connectionId: string, runtimeGeneration: number) =>
    ["control-plane", "conformance", "runs", connectionId, runtimeGeneration] as const,
  conformanceRun: (runId: string) => ["control-plane", "conformance", "run", runId] as const,
  conformancePrefix: (connectionId: string) =>
    ["control-plane", "conformance", "runs", connectionId] as const,
};

const transientPhases: ReadonlySet<RuntimePhase> = new Set([
  "queued",
  "connecting",
  "degraded",
  "draining",
]);

export const TRANSIENT_POLL_INTERVAL_MS = 1_250;
export const METRICS_POLL_INTERVAL_MS = 5_000;
export const HEALTH_POLL_INTERVAL_MS = 10_000;
export const CONFORMANCE_RUN_POLL_INTERVAL_MS = 1_000;

export function isTransientPhase(phase: RuntimePhase): boolean {
  return transientPhases.has(phase);
}

export function connectionPollInterval(
  connections: readonly Connection[] | undefined,
): number | false {
  return connections?.some((connection) => isTransientPhase(connection.runtime.phase)) === true
    ? TRANSIENT_POLL_INTERVAL_MS
    : false;
}

export function runtimePollInterval(runtime: RuntimeManager | undefined): number | false {
  return runtime !== undefined &&
    (runtime.pendingConnectionCount > 0 || runtime.closingConnectionCount > 0)
    ? TRANSIENT_POLL_INTERVAL_MS
    : false;
}

export function conformanceRunPollInterval(run: ConformanceRun | undefined): number | false {
  return run?.status === "queued" || run?.status === "running" || run?.status === "cancelling"
    ? CONFORMANCE_RUN_POLL_INTERVAL_MS
    : false;
}

export function conformanceRunsQueryOptions(connection: Connection) {
  return queryOptions({
    queryKey: controlPlaneKeys.conformanceRuns(connection.id, connection.runtimeGeneration),
    queryFn: ({ signal }) =>
      controlPlaneApi.listConformanceRuns(connection.id, connection.runtimeGeneration, 5, signal),
    retry: false,
  });
}

export function conformanceRunQueryOptions(runId: string | undefined) {
  return queryOptions({
    enabled: runId !== undefined,
    queryKey: controlPlaneKeys.conformanceRun(runId ?? "pending"),
    queryFn: ({ signal }) => {
      if (runId === undefined)
        return Promise.reject(new Error("A conformance run ID is required."));
      return controlPlaneApi.getConformanceRun(runId, signal);
    },
    refetchInterval: (query) => conformanceRunPollInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function startConformanceRunMutationOptions() {
  return mutationOptions<ConformanceRun, Error, Connection>({
    mutationKey: ["control-plane", "conformance", "start"] as const,
    mutationFn: (connection) => controlPlaneApi.startConformanceRun(connection),
    retry: false,
  });
}

export function cancelConformanceRunMutationOptions() {
  return mutationOptions<ConformanceRun, Error, string>({
    mutationKey: ["control-plane", "conformance", "cancel"] as const,
    mutationFn: (runId) => controlPlaneApi.cancelConformanceRun(runId),
    retry: false,
  });
}

export function metricsQueryOptions() {
  return queryOptions({
    queryKey: controlPlaneKeys.metrics,
    queryFn: ({ signal }) => controlPlaneApi.metricsSnapshot(signal),
    refetchInterval: METRICS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function liveHealthQueryOptions() {
  return queryOptions({
    queryKey: controlPlaneKeys.healthLive,
    queryFn: ({ signal }) => controlPlaneApi.liveHealth(signal),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export function readyHealthQueryOptions() {
  return queryOptions({
    queryKey: controlPlaneKeys.healthReady,
    queryFn: ({ signal }) => controlPlaneApi.readyHealth(signal),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export function hubQueryOptions() {
  return queryOptions({
    queryKey: controlPlaneKeys.hub,
    queryFn: ({ signal }) => controlPlaneApi.hubSnapshot(signal),
  });
}

export function hubCatalogQueryOptions(hubRevision: number | undefined) {
  return queryOptions({
    enabled: hubRevision !== undefined,
    queryKey: controlPlaneKeys.hubCatalog(hubRevision ?? 0),
    queryFn: ({ signal }) => {
      if (hubRevision === undefined) {
        return Promise.reject(
          new Error("A Hub revision is required to read its projected catalog."),
        );
      }
      return controlPlaneApi.getHubCatalog(hubRevision, signal);
    },
  });
}

export interface AttachHubMemberInput {
  readonly connection: Connection;
  readonly hubRevision: number;
  readonly namespace: string;
}

export function attachHubMemberMutationOptions() {
  return mutationOptions<Hub, Error, AttachHubMemberInput>({
    mutationKey: ["control-plane", "hub", "member"] as const,
    mutationFn: ({ connection, hubRevision, namespace }) =>
      controlPlaneApi.attachHubMember({
        connectionId: connection.id,
        expectedConnectionRevision: connection.revision,
        expectedHubRevision: hubRevision,
        namespace,
        runtimeGeneration: connection.runtimeGeneration,
      }),
    retry: false,
  });
}

export interface DetachHubMemberInput {
  readonly hubRevision: number;
  readonly member: HubMember;
}

export function detachHubMemberMutationOptions() {
  return mutationOptions<void, Error, DetachHubMemberInput>({
    mutationKey: ["control-plane", "hub", "member"] as const,
    mutationFn: ({ hubRevision, member }) =>
      controlPlaneApi.detachHubMember(member.connectionId, hubRevision, member.runtimeGeneration),
    retry: false,
  });
}

export function refreshHubCatalogMutationOptions() {
  return mutationOptions<Hub, Error, number>({
    mutationKey: controlPlaneKeys.hubRefresh,
    mutationFn: (hubRevision) => controlPlaneApi.refreshHubCatalog(hubRevision),
    retry: false,
  });
}

export function toolCallMutationOptions(connectionId: string) {
  return mutationOptions<ToolCallResult, Error, ToolCallInput>({
    mutationKey: controlPlaneKeys.toolCall(connectionId),
    mutationFn: (input) => controlPlaneApi.callTool(connectionId, input),
    // A tool may have external side effects, so transport failures must never trigger a replay.
    retry: false,
  });
}

export function resourceReadMutationOptions(connectionId: string) {
  return mutationOptions<ReadResourceResult, Error, ReadResourceInput>({
    mutationKey: controlPlaneKeys.resourceRead(connectionId),
    mutationFn: (input) => controlPlaneApi.readResource(connectionId, input),
    // Keep validation reads user-triggered; a transport failure must not replay the request.
    retry: false,
  });
}

export function promptGetMutationOptions(connectionId: string) {
  return mutationOptions<GetPromptResult, Error, GetPromptInput>({
    mutationKey: controlPlaneKeys.promptGet(connectionId),
    mutationFn: (input) => controlPlaneApi.getPrompt(connectionId, input),
    // Prompt rendering can invoke upstream work, so every attempt remains explicit.
    retry: false,
  });
}
