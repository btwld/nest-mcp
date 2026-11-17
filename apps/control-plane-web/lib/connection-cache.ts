import type { Connection, RuntimeState } from "@/lib/control-plane-api";

export function mergeConnection(
  current: readonly Connection[] | undefined,
  incoming: Connection,
): Connection[] {
  if (!current) return [incoming];
  const existing = current.find((candidate) => candidate.id === incoming.id);
  if (!existing) return [...current, incoming];
  if (existing.revision > incoming.revision) return [...current];
  return current.map((candidate) => (candidate.id === incoming.id ? incoming : candidate));
}

export function mergeObservedRuntime(
  current: readonly Connection[] | undefined,
  observed: Pick<Connection, "id" | "revision" | "runtimeGeneration">,
  runtime: RuntimeState,
): Connection[] | undefined {
  return current?.map((candidate) =>
    candidate.id === observed.id &&
    candidate.revision === observed.revision &&
    candidate.runtimeGeneration === observed.runtimeGeneration
      ? { ...candidate, runtime }
      : candidate,
  );
}
