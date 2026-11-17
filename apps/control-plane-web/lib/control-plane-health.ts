import type { LiveHealth, ReadyHealth } from "./control-plane-api";

export type ControlPlaneHealthStatus = "checking" | "ready" | "not-ready" | "unreachable";

export function deriveControlPlaneHealthStatus({
  live,
  ready,
  liveFailed,
  readyFailed,
}: {
  readonly live: LiveHealth | undefined;
  readonly ready: ReadyHealth | undefined;
  readonly liveFailed: boolean;
  readonly readyFailed: boolean;
}): ControlPlaneHealthStatus {
  if (liveFailed) return "unreachable";
  if (live?.status !== "live") return "checking";
  if (readyFailed) return "not-ready";
  return ready?.status === "ready" ? "ready" : "checking";
}
