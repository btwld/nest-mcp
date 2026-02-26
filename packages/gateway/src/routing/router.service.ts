import { Injectable, Logger } from '@nestjs/common';
import type { UpstreamConfig } from '../upstream/upstream.interface';
import type { ResolvedRoute, RoutingConfig } from './route-config.interface';

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly prefixToName = new Map<string, string>();
  private readonly nameToPrefix = new Map<string, string>();

  configure(upstreams: UpstreamConfig[], _routing: RoutingConfig): void {
    this.prefixToName.clear();
    this.nameToPrefix.clear();

    for (const upstream of upstreams) {
      if (upstream.enabled === false) continue;
      const prefix = upstream.toolPrefix ?? upstream.name;
      this.prefixToName.set(prefix, upstream.name);
      this.nameToPrefix.set(upstream.name, prefix);
    }

    this.logger.log(`Configured prefix routing for ${this.prefixToName.size} upstreams`);
  }

  resolve(toolName: string): ResolvedRoute | undefined {
    const separatorIndex = toolName.indexOf('_');
    if (separatorIndex === -1) return undefined;

    const prefix = toolName.substring(0, separatorIndex);
    const upstreamName = this.prefixToName.get(prefix);

    if (!upstreamName) return undefined;

    return {
      upstreamName,
      originalToolName: toolName.substring(separatorIndex + 1),
    };
  }

  buildPrefixedName(prefix: string, toolName: string): string {
    return `${prefix}_${toolName}`;
  }

  getPrefixForUpstream(upstreamName: string): string | undefined {
    return this.nameToPrefix.get(upstreamName);
  }
}
