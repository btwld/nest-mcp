import type { Connection, Hub, HubMember } from "./control-plane-api";

const HUB_NAMESPACE_MAX_LENGTH = 32;
const NON_NAMESPACE_CHARACTER = /[^a-z0-9]+/gu;
const EDGE_HYPHENS = /^-+|-+$/gu;

export function canExposeConnection(connection: Connection): boolean {
  return (
    !connection.deletionPending &&
    connection.desiredState === "online" &&
    connection.runtime.phase === "online"
  );
}

export function retainNewestEndpointSnapshot(current: Hub | undefined, incoming: Hub): Hub {
  return current !== undefined && current.revision > incoming.revision ? current : incoming;
}

export function suggestExposureNamespace(
  displayName: string,
  members: readonly Pick<HubMember, "namespace">[],
): string {
  const used = new Set(members.map((member) => member.namespace));
  const normalized = displayName
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(NON_NAMESPACE_CHARACTER, "-")
    .replace(EDGE_HYPHENS, "");
  const startsWithLetter = /^[a-z]/u.test(normalized);
  const base = truncateNamespace(
    startsWithLetter ? normalized : normalized.length > 0 ? `mcp-${normalized}` : "mcp",
  );
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const ending = `-${String(suffix)}`;
    const candidate = `${truncateNamespace(base, HUB_NAMESPACE_MAX_LENGTH - ending.length)}${ending}`;
    if (!used.has(candidate)) return candidate;
  }
  return "mcp";
}

function truncateNamespace(value: string, maximum = HUB_NAMESPACE_MAX_LENGTH): string {
  return value.slice(0, maximum).replace(/-+$/u, "") || "mcp";
}
