import {
  type ClientContext,
  type ExposureStrategy,
  type ExposureStrategyResolver,
  RESOLVER_KINDS,
  type ToolSelector,
} from '../interfaces/mcp-exposure.interface';
import { clientSupports } from './exposure-capabilities';

/**
 * Return type of {@link defineResolver}. The declared `kinds` are carried on
 * the branded property as a literal tuple (via the `const` type parameter),
 * so downstream consumers — including `ExposureService` — see the exact set
 * of strategy kinds the resolver can produce rather than the widened
 * `ExposureStrategy['kind'][]`.
 *
 * The return type is also narrowed to `Extract<ExposureStrategy, { kind: K }>`
 * so callers can rely on the kind discriminant if they introspect the
 * resolver's output statically.
 */
export type DeclaredExposureStrategyResolver<K extends ExposureStrategy['kind']> = ((
  ctx: ClientContext,
) => Extract<ExposureStrategy, { kind: K }>) & {
  readonly [RESOLVER_KINDS]: readonly K[];
};

/**
 * Wrap a resolver function with a declaration of which strategy kinds it can
 * produce. `ExposureService` uses this declaration to decide whether to
 * register `kind: 'lazy'` meta-tools at bootstrap or leave them off entirely.
 *
 * Without this wrapper, the service must assume a plain resolver *could*
 * return `lazy` and registers meta-tools defensively — a safe default, but
 * one that pollutes the registry when the resolver never actually returns
 * `lazy`. Declaring kinds up front eliminates that drift.
 *
 * @example
 * ```ts
 * const exposure = defineResolver(['search', 'lazy'], (ctx) =>
 *   clientSupports.search(ctx)
 *     ? { kind: 'search', variant: 'bm25', eager: { tags: ['core'] } }
 *     : { kind: 'lazy', eager: { tags: ['core'] } },
 * );
 * ```
 */
export function defineResolver<const K extends ExposureStrategy['kind']>(
  kinds: readonly K[],
  resolve: (ctx: ClientContext) => Extract<ExposureStrategy, { kind: K }>,
): DeclaredExposureStrategyResolver<K> {
  return Object.defineProperty(resolve, RESOLVER_KINDS, {
    value: Object.freeze([...kinds]),
    enumerable: false,
    writable: false,
    configurable: false,
  }) as DeclaredExposureStrategyResolver<K>;
}

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
  return defineResolver(['search', 'lazy'], (ctx) =>
    clientSupports.search(ctx)
      ? { kind: 'search', variant, eager }
      : {
          kind: 'lazy',
          eager,
          ...(indexToolName ? { indexToolName } : {}),
          ...(schemaToolName ? { schemaToolName } : {}),
        },
  );
}
