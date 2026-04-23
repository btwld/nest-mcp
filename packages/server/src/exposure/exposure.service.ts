import {
  type ClientContext,
  type ExposureStrategy,
  type ExposureStrategyResolver,
  type LazyStrategyOptions,
  MCP_OPTIONS,
  META_DEFER_LOADING,
  type McpModuleOptions,
  RESOLVER_KINDS,
  type ToolListEntry,
  type ToolMetadata,
  type ToolSelector,
} from '@nest-mcp/common';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';
import {
  DEFAULT_SCHEMA_TOOL_DESCRIPTION,
  DEFAULT_SCHEMA_TOOL_NAME,
  type GetToolSchemaArgs,
  type GetToolSchemaResult,
  getToolSchema,
  getToolSchemaSchema,
} from './meta-tools/get-tool-schema';
import {
  DEFAULT_LIST_TOOL_DESCRIPTION,
  DEFAULT_LIST_TOOL_NAME,
  type ListAvailableToolsArgs,
  type ListAvailableToolsResult,
  listAvailableTools,
  listAvailableToolsSchema,
} from './meta-tools/list-available-tools';
import { isEager } from './selector';

interface ResolvedMetaToolNames {
  indexToolName: string;
  schemaToolName: string;
}

/**
 * Applies a catalog-presentation strategy to `tools/list` responses.
 *
 * Responsibilities:
 *  - Resolve the concrete strategy for each client (static option or resolver).
 *  - Transform executor-built tool entries per the resolved strategy:
 *    `eager` (no-op), `search` (annotate with `_meta.defer_loading`),
 *    `lazy` (filter to eager + meta-tools), `typed-api` (reserved).
 *  - Register the `list_available_tools` / `get_tool_schema` meta-tools
 *    at bootstrap when `lazy` is reachable.
 *  - Validate config at application bootstrap (name collisions, all-deferred,
 *    incompatible combinations).
 *
 * The service is a singleton and pure-per-request: client state lives in the
 * {@link ClientContext} parameter, never on the service.
 */
@Injectable()
export class ExposureService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExposureService.name);
  private readonly configured: ExposureStrategy | ExposureStrategyResolver;
  private readonly metaToolNames = new Set<string>();
  private readonly metaToolConfig: ResolvedMetaToolNames;
  private readonly maxBatchSize: number;

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
  ) {
    this.configured = options.exposure ?? { kind: 'eager' };
    const lazyHint = this.lazyHint();
    this.metaToolConfig = {
      indexToolName: lazyHint?.indexToolName ?? DEFAULT_LIST_TOOL_NAME,
      schemaToolName: lazyHint?.schemaToolName ?? DEFAULT_SCHEMA_TOOL_NAME,
    };
    this.maxBatchSize = lazyHint?.maxBatchSize ?? 20;
  }

  /**
   * Runs after all `onModuleInit` hooks (including the scanner) have populated
   * the registry. We validate collisions against the scanned tools *before*
   * registering our meta-tools so an existing tool with the same name is a
   * hard error, not a silent overwrite.
   */
  onApplicationBootstrap(): void {
    if (this.canResolveToLazy()) {
      this.validateNameCollisions();
      this.registerMetaTools();
    }
    this.validateSearchReachable();
  }

  // ---- Public API ----

  /**
   * Resolve the concrete strategy for the given client context. If the
   * module was configured with a static strategy, returns it unchanged;
   * if configured with a resolver function, invokes it with `ctx`.
   */
  resolveForClient(ctx: ClientContext): ExposureStrategy {
    return typeof this.configured === 'function' ? this.configured(ctx) : this.configured;
  }

  /**
   * Transform a list of tool entries (as produced by the executor) according
   * to the resolved strategy. Meta-tools are always present in the registry
   * but only surfaced in the response when `kind: 'lazy'` is active.
   *
   * @param entries - Pre-mapped tool entries (one per registered tool).
   * @param metas   - Parallel map of tool name to metadata, for selector evaluation.
   * @param ctx     - Client context used to resolve the strategy.
   */
  applyStrategy(
    entries: ToolListEntry[],
    metas: Map<string, ToolMetadata>,
    ctx: ClientContext,
  ): ToolListEntry[] {
    const strategy = this.resolveForClient(ctx);

    switch (strategy.kind) {
      case 'eager':
        return this.withoutMetaTools(entries);
      case 'search':
        return this.applySearch(entries, metas, strategy.eager);
      case 'lazy':
        return this.applyLazy(entries, metas, strategy.eager);
      case 'typed-api':
        throw new Error(
          "ExposureStrategy kind 'typed-api' is reserved and not implemented in this release",
        );
      default: {
        // Exhaustiveness guard — adding a new `kind` to ExposureStrategy
        // becomes a compile error here instead of a silent fallthrough.
        const _exhaustive: never = strategy;
        return _exhaustive;
      }
    }
  }

  // ---- Meta-tool handlers (invoked by the executor via registerTool) ----

  async handleListAvailableTools(args: ListAvailableToolsArgs): Promise<ListAvailableToolsResult> {
    const all = this.registry.getAllTools();
    const entries = all
      .filter((t) => !this.metaToolNames.has(t.name))
      .map((meta) => ({
        meta,
        oneLineDescription: meta.description.split('\n')[0] ?? meta.description,
      }));
    return listAvailableTools(entries, args);
  }

  async handleGetToolSchema(args: GetToolSchemaArgs): Promise<GetToolSchemaResult> {
    const pool = new Map<string, ToolMetadata>();
    for (const t of this.registry.getAllTools()) {
      if (!this.metaToolNames.has(t.name)) pool.set(t.name, t);
    }
    return getToolSchema(pool, args, this.maxBatchSize);
  }

  // ---- Strategy implementations ----

  private applySearch(
    entries: ToolListEntry[],
    metas: Map<string, ToolMetadata>,
    eager: ToolSelector | undefined,
  ): ToolListEntry[] {
    return this.withoutMetaTools(entries).map((entry) => {
      const meta = metas.get(entry.name);
      if (!meta || isEager(meta, eager)) {
        return entry;
      }
      return {
        ...entry,
        _meta: { ...(entry._meta ?? {}), [META_DEFER_LOADING]: true },
      };
    });
  }

  private applyLazy(
    entries: ToolListEntry[],
    metas: Map<string, ToolMetadata>,
    eager: ToolSelector | undefined,
  ): ToolListEntry[] {
    return entries.filter((entry) => {
      if (this.metaToolNames.has(entry.name)) return true;
      const meta = metas.get(entry.name);
      if (!meta) return true;
      return isEager(meta, eager);
    });
  }

  private withoutMetaTools(entries: ToolListEntry[]): ToolListEntry[] {
    return entries.filter((e) => !this.metaToolNames.has(e.name));
  }

  // ---- Configuration introspection ----

  private lazyHint(): LazyStrategyOptions | undefined {
    if (typeof this.configured !== 'object' || this.configured.kind !== 'lazy') return undefined;
    return this.configured;
  }

  private canResolveToLazy(): boolean {
    return this.canResolveTo('lazy');
  }

  private canResolveToSearch(): boolean {
    return this.canResolveTo('search');
  }

  /**
   * Decide whether the configured strategy could resolve to a given kind.
   *
   * - Static strategies: exact answer from the `kind` discriminant.
   * - Resolver functions with declared kinds (via `defineResolver`): exact
   *   answer from the declaration.
   * - Plain resolver functions: conservative `true`, with a one-time warning
   *   suggesting the user wrap with `defineResolver` to tighten behavior.
   */
  private canResolveTo(kind: ExposureStrategy['kind']): boolean {
    if (typeof this.configured !== 'function') {
      return this.configured.kind === kind;
    }
    const declared = this.configured[RESOLVER_KINDS];
    if (declared) {
      return declared.includes(kind);
    }
    this.warnUndeclaredResolverOnce();
    return true; // conservative fallback
  }

  private warnedUndeclaredResolver = false;

  private warnUndeclaredResolverOnce(): void {
    if (this.warnedUndeclaredResolver) return;
    this.warnedUndeclaredResolver = true;
    this.logger.warn(
      'ExposureService: the configured resolver does not declare which strategy kinds it can produce. ' +
        'Wrap with `defineResolver([...kinds], fn)` from @nest-mcp/common to avoid conservative meta-tool registration.',
    );
  }

  // ---- Registration ----

  private registerMetaTools(): void {
    const { indexToolName, schemaToolName } = this.metaToolConfig;
    this.metaToolNames.add(indexToolName);
    this.metaToolNames.add(schemaToolName);

    // Single `as` cast rather than `as unknown as` laundering — `ToolMetadata.target`
    // uses `never[]` in the parameter position (see its definition), so any concrete
    // constructor is structurally assignable with one hop.
    const target = ExposureService as abstract new (...args: never[]) => unknown;
    const instance = this as unknown as Record<string, unknown>;

    this.registry.registerTool({
      name: indexToolName,
      description: DEFAULT_LIST_TOOL_DESCRIPTION,
      parameters: listAvailableToolsSchema,
      exposure: 'eager',
      methodName: 'handleListAvailableTools',
      target,
      instance,
    });

    this.registry.registerTool({
      name: schemaToolName,
      description: DEFAULT_SCHEMA_TOOL_DESCRIPTION,
      parameters: getToolSchemaSchema,
      exposure: 'eager',
      methodName: 'handleGetToolSchema',
      target,
      instance,
    });
  }

  // ---- Validation ----

  private validateNameCollisions(): void {
    const { indexToolName, schemaToolName } = this.metaToolConfig;
    for (const name of [indexToolName, schemaToolName]) {
      if (this.registry.getTool(name)) {
        throw new Error(
          `ExposureService: meta-tool name '${name}' collides with an existing tool. Set exposure.indexToolName / schemaToolName to a unique value.`,
        );
      }
    }
  }

  private validateSearchReachable(): void {
    // Resolver-based strategies can't be statically validated — their eager
    // selector depends on runtime client context. Validation runs implicitly
    // at request time (Anthropic's API rejects all-deferred requests).
    if (typeof this.configured === 'function') return;
    if (this.configured.kind !== 'search') return;

    const strategy = this.configured;
    const tools = this.registry.getAllTools().filter((t) => !this.metaToolNames.has(t.name));
    if (tools.length === 0) return;

    const anyEager = tools.some((t) => isEager(t, strategy.eager));
    if (anyEager) return;

    const behavior = strategy.onAllDeferred ?? 'throw';
    const message = `ExposureService: kind 'search' resolved zero eager tools. Anthropic requires at least one non-deferred tool per request. Add 'eager' tags to your core tools or set exposure.onAllDeferred to override.`;
    if (behavior === 'throw') throw new Error(message);
    if (behavior === 'warn') this.logger.warn(message);
    // 'promoteFirst' is handled at transform time.
  }
}
