import { Injectable, Logger } from '@nestjs/common';
import type { UpstreamConfig } from '../upstream/upstream.interface';
import type { ResolvedRoute, RoutingConfig } from './route-config.interface';

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly prefixToName = new Map<string, string>();
  private readonly nameToPrefix = new Map<string, string>();
  /** Registered prefixes, longest first, so the most specific prefix wins in {@link resolve}. */
  private prefixesBySpecificity: string[] = [];

  /**
   * Build the prefix routing table.
   *
   * @throws Error when two enabled upstreams resolve to the same prefix
   *   (`toolPrefix`, or `name` when no prefix is set) — their tools would
   *   otherwise shadow each other.
   */
  configure(upstreams: UpstreamConfig[], _routing: RoutingConfig): void {
    this.prefixToName.clear();
    this.nameToPrefix.clear();

    for (const upstream of upstreams) {
      if (upstream.enabled === false) continue;
      const prefix = upstream.toolPrefix ?? upstream.name;
      const existing = this.prefixToName.get(prefix);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate tool prefix "${prefix}" for upstreams "${existing}" and "${upstream.name}". Give each upstream a unique "toolPrefix" (or "name").`,
        );
      }
      this.prefixToName.set(prefix, upstream.name);
      this.nameToPrefix.set(upstream.name, prefix);
    }

    this.prefixesBySpecificity = Array.from(this.prefixToName.keys()).sort(
      (a, b) => b.length - a.length,
    );
    this.warnOnOverlappingPrefixes();

    this.logger.log(`Configured prefix routing for ${this.prefixToName.size} upstreams`);
  }

  /**
   * Resolve a gateway tool name to its upstream by matching the longest
   * registered prefix followed by `_`, so prefixes may themselves contain
   * underscores (`my_api_search` routes to prefix `my_api` when registered).
   */
  resolve(toolName: string): ResolvedRoute | undefined {
    for (const prefix of this.prefixesBySpecificity) {
      if (!toolName.startsWith(`${prefix}_`)) continue;
      const upstreamName = this.prefixToName.get(prefix);
      if (!upstreamName) continue;
      return {
        upstreamName,
        originalToolName: toolName.substring(prefix.length + 1),
      };
    }
    return undefined;
  }

  buildPrefixedName(prefix: string, toolName: string): string {
    return `${prefix}_${toolName}`;
  }

  getPrefixForUpstream(upstreamName: string): string | undefined {
    return this.nameToPrefix.get(upstreamName);
  }

  /**
   * Prefixes such as `api` and `api_v2` both match `api_v2_search`; the
   * longer prefix wins, so an `api` tool named `v2_search` is unreachable.
   */
  private warnOnOverlappingPrefixes(): void {
    for (const longer of this.prefixesBySpecificity) {
      for (const shorter of this.prefixesBySpecificity) {
        if (shorter.length < longer.length && longer.startsWith(`${shorter}_`)) {
          this.logger.warn(
            `Tool prefix "${longer}" (upstream "${this.prefixToName.get(longer)}") overlaps prefix "${shorter}" (upstream "${this.prefixToName.get(shorter)}"); tools named "${longer}_*" route to "${this.prefixToName.get(longer)}".`,
          );
        }
      }
    }
  }
}
