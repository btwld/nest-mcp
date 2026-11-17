import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Icon, ToolAnnotations, ToolExecution } from '@nest-mcp/common';
import { drainAllPages } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { isSpecCompliantToolName } from '../utils/tool-name';
import { RouterService } from './router.service';

type UpstreamClient = NonNullable<ReturnType<UpstreamManagerService['getClient']>>;

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface AggregatedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: ToolInputSchema;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  /**
   * Upstream execution hints. Omitted when the upstream declares
   * `taskSupport: 'optional' | 'required'`: the gateway proxies tools with
   * plain `tools/call` and cannot run them as tasks.
   */
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
  upstreamName: string;
  originalName: string;
}

@Injectable()
export class ToolAggregatorService {
  private readonly logger = new Logger(ToolAggregatorService.name);
  private cachedTools: AggregatedTool[] = [];

  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly router: RouterService,
  ) {}

  async aggregateAll(): Promise<AggregatedTool[]> {
    const names = this.upstreamManager.getAllNames();
    const results = await Promise.allSettled(
      names.map((name) => this.fetchToolsFromUpstream(name)),
    );
    const allTools = collectFulfilled(results);

    this.cachedTools = allTools;
    this.logger.log(`Aggregated ${allTools.length} tools from ${names.length} upstreams`);
    return allTools;
  }

  /**
   * Re-fetch the tools of a single upstream and replace its entries in the
   * cache. Returns the fresh tools, or `undefined` (cache untouched) when the
   * upstream is unavailable or the listing fails.
   */
  async refreshUpstream(upstreamName: string): Promise<AggregatedTool[] | undefined> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client || !this.upstreamManager.isHealthy(upstreamName)) return undefined;
    try {
      const tools = await this.loadToolsFromUpstream(upstreamName, client);
      this.cachedTools = [
        ...this.cachedTools.filter((t) => t.upstreamName !== upstreamName),
        ...tools,
      ];
      return tools;
    } catch (error) {
      this.logger.error(
        `Failed to refresh tools from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async fetchToolsFromUpstream(upstreamName: string): Promise<AggregatedTool[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for tool aggregation`);
      return [];
    }

    try {
      return await this.loadToolsFromUpstream(upstreamName, client);
    } catch (error) {
      this.logger.error(
        `Failed to fetch tools from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async loadToolsFromUpstream(
    upstreamName: string,
    client: UpstreamClient,
  ): Promise<AggregatedTool[]> {
    const prefix = this.router.getPrefixForUpstream(upstreamName);
    const allTools = await drainAllPages(async (cursor) => {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      return { data: result.tools ?? [], nextCursor: result.nextCursor };
    });

    return allTools.map((tool) => this.toAggregated(tool, upstreamName, prefix));
  }

  private toAggregated(tool: Tool, upstreamName: string, prefix?: string): AggregatedTool {
    const name = prefix ? this.router.buildPrefixedName(prefix, tool.name) : tool.name;
    if (!isSpecCompliantToolName(name)) {
      this.logger.warn(
        `Tool "${name}" from upstream "${upstreamName}" does not follow the MCP tool-name guidance (1-128 characters from A-Z, a-z, 0-9, "_", "-", ".") and may be rejected by clients`,
      );
    }

    const taskSupport = tool.execution?.taskSupport;
    const proxyableExecution = taskSupport !== 'optional' && taskSupport !== 'required';
    if (!proxyableExecution) {
      this.logger.debug(
        `Not advertising taskSupport "${taskSupport}" for "${name}": the gateway proxies tools without task augmentation`,
      );
    }

    return {
      name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema as ToolInputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
      ...(tool.annotations ? { annotations: tool.annotations as ToolAnnotations } : {}),
      ...(tool.icons ? { icons: tool.icons as Icon[] } : {}),
      ...(tool.execution && proxyableExecution
        ? { execution: tool.execution as ToolExecution }
        : {}),
      ...(tool._meta ? { _meta: tool._meta as Record<string, unknown> } : {}),
      upstreamName,
      originalName: tool.name,
    };
  }

  getCachedTools(): AggregatedTool[] {
    return this.cachedTools;
  }
}
