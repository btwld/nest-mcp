import type { ExposureStrategyResolver, ToolSelector } from '../interfaces/mcp-exposure.interface';
import { clientSupports } from './exposure-capabilities';

export interface PreferSearchElseLazyOptions {
  /** Tool selector shared across both strategies. */
  eager?: ToolSelector;
  /** Search variant when `search` is selected. Default: `bm25`. */
  variant?: 'regex' | 'bm25';
  /** Index meta-tool name when `lazy` is selected. */
  indexToolName?: string;
  /** Schema-fetch meta-tool name when `lazy` is selected. */
  schemaToolName?: string;
}

/**
 * Preset resolver: emits `kind: 'search'` for clients that declared the
 * advanced-tool-use beta header, otherwise falls back to `kind: 'lazy'`.
 * Never returns `eager` — this preset is meant for catalogs that would
 * bloat context if surfaced up front.
 *
 * @example
 * ```ts
 * McpModule.forRoot({
 *   exposure: preferSearchElseLazy({ eager: { tags: ['core'] } }),
 * });
 * ```
 */
export function preferSearchElseLazy(
  options: PreferSearchElseLazyOptions = {},
): ExposureStrategyResolver {
  const { eager, variant = 'bm25', indexToolName, schemaToolName } = options;
  return (ctx) =>
    clientSupports.search(ctx)
      ? { kind: 'search', variant, eager }
      : {
          kind: 'lazy',
          eager,
          ...(indexToolName ? { indexToolName } : {}),
          ...(schemaToolName ? { schemaToolName } : {}),
        };
}
