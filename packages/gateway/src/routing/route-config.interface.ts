export type ToolRoutingStrategy = 'prefix';

export interface RoutingConfig {
  toolRouting: ToolRoutingStrategy;
  aggregateToolLists?: boolean;
}

export interface ResolvedRoute {
  upstreamName: string;
  originalToolName: string;
}
