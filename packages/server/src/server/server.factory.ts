import type { McpModuleOptions } from '@btwld/mcp-common';
import { buildServerCapabilities } from '@btwld/mcp-common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '@nestjs/common';
import type { McpRegistryService } from '../discovery/registry.service';

export function createMcpServer(
  registry: McpRegistryService,
  options: McpModuleOptions,
): McpServer {
  const logger = new Logger('McpServerFactory');

  const capabilities = buildServerCapabilities(options, {
    hasTools: registry.hasTools,
    hasResources: registry.hasResources,
    hasResourceTemplates: registry.hasResourceTemplates,
    hasPrompts: registry.hasPrompts,
  });

  logger.debug(`Building MCP server '${options.name}' v${options.version}`);

  const mcpServer = new McpServer(
    { name: options.name, version: options.version },
    {
      // biome-ignore lint/suspicious/noExplicitAny: McpServer constructor expects its own capability type that differs from our generic type
      capabilities: capabilities as any,
      ...(options.description ? { instructions: options.description } : {}),
    },
  );

  return mcpServer;
}
