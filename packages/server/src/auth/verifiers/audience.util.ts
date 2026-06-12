import { canonicalizeResourceUri } from '../utils/resource-url.util';

/**
 * True when any `aud` entry identifies the configured resource. Matching is
 * exact (after canonicalization — case/trailing-slash/fragment differences
 * are tolerated): the MCP spec requires servers to only accept tokens issued
 * specifically for them, so a broader audience (e.g. the bare origin for a
 * pathful resource) is NOT accepted. Authorization servers with different
 * audience conventions should be configured via the explicit `audience`
 * option or a custom verifier.
 */
export function audienceMatches(aud: unknown, resource: string): boolean {
  const entries = Array.isArray(aud) ? aud : [aud];
  return entries.some((entry) => {
    if (typeof entry !== 'string' || !entry) return false;
    try {
      return canonicalizeResourceUri(entry) === resource;
    } catch {
      return entry === resource;
    }
  });
}
