import {
  type ClientContext,
  type ExposureStrategy,
  type ExposureStrategyResolver,
  MCP_OPTIONS,
  META_DEFER_LOADING,
  type McpModuleOptions,
  type ToolMetadata,
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
    entries: Array<Record<string, unknown>>,
    metas: Map<string, ToolMetadata>,
    ctx: ClientContext,
  ): Array<Record<string, unknown>> {
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
    entries: Array<Record<string, unknown>>,
    metas: Map<string, ToolMetadata>,
    eager: Parameters<typeof isEager>[1],
  ): Array<Record<string, unknown>> {
    return this.withoutMetaTools(entries).map((entry) => {
      const name = entry.name as string;
      const meta = metas.get(name);
      if (!meta || isEager(meta, eager)) {
        return entry;
      }
      const prev = (entry._meta as Record<string, unknown> | undefined) ?? {};
      return {
        ...entry,
        _meta: { ...prev, [META_DEFER_LOADING]: true },
      };
    });
  }

  private applyLazy(
    entries: Array<Record<string, unknown>>,
    metas: Map<string, ToolMetadata>,
    eager: Parameters<typeof isEager>[1],
  ): Array<Record<string, unknown>> {
    return entries.filter((entry) => {
      const name = entry.name as string;
      if (this.metaToolNames.has(name)) return true; // always include meta-tools under lazy
      const meta = metas.get(name);
      if (!meta) return true;
      return isEager(meta, eager);
    });
  }

  private withoutMetaTools(
    entries: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return entries.filter((e) => !this.metaToolNames.has(e.name as string));
  }

  // ---- Configuration introspection ----

  private lazyHint():
    | { indexToolName?: string; schemaToolName?: string; maxBatchSize?: number }
    | undefined {
    if (typeof this.configured !== 'object' || this.configured.kind !== 'lazy') return undefined;
    return this.configured;
  }

  private canResolveToLazy(): boolean {
    // Resolver form: we can't know statically what it returns. Register to be safe.
    if (typeof this.configured === 'function') return true;
    return this.configured.kind === 'lazy';
  }

  private canResolveToSearch(): boolean {
    if (typeof this.configured === 'function') return true;
    return this.configured.kind === 'search';
  }

  // ---- Registration ----

  private registerMetaTools(): void {
    const { indexToolName, schemaToolName } = this.metaToolConfig;
    this.metaToolNames.add(indexToolName);
    this.metaToolNames.add(schemaToolName);

    const indexTool: RegisteredTool = {
      name: indexToolName,
      description: DEFAULT_LIST_TOOL_DESCRIPTION,
      parameters: listAvailableToolsSchema,
      exposure: 'eager',
      methodName: 'handleListAvailableTools',
      target: ExposureService as unknown as abstract new (...args: unknown[]) => unknown,
      instance: this as unknown as Record<string, unknown>,
    };

    const schemaTool: RegisteredTool = {
      name: schemaToolName,
      description: DEFAULT_SCHEMA_TOOL_DESCRIPTION,
      parameters: getToolSchemaSchema,
      exposure: 'eager',
      methodName: 'handleGetToolSchema',
      target: ExposureService as unknown as abstract new (...args: unknown[]) => unknown,
      instance: this as unknown as Record<string, unknown>,
    };

    this.registry.registerTool(indexTool);
    this.registry.registerTool(schemaTool);
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
    if (!this.canResolveToSearch()) return;
    const strategy = typeof this.configured === 'function' ? undefined : this.configured;

    // Only static search strategies can be exhaustively validated at bootstrap.
    if (!strategy || strategy.kind !== 'search') return;

    const tools = this.registry.getAllTools().filter((t) => !this.metaToolNames.has(t.name));
    const anyEager = tools.some((t) => isEager(t, strategy.eager));
    if (tools.length > 0 && !anyEager) {
      const behavior = strategy.onAllDeferred ?? 'throw';
      const message = `ExposureService: kind 'search' resolved zero eager tools. Anthropic requires at least one non-deferred tool per request. Add 'eager' tags to your core tools or set exposure.onAllDeferred to override.`;
      if (behavior === 'throw') {
        throw new Error(message);
      }
      if (behavior === 'warn') {
        this.logger.warn(message);
      }
      // 'promoteFirst' is handled at transform time
    }
  }
}
