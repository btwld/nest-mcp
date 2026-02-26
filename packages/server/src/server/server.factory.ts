import type { McpModuleOptions } from '@btwld/mcp-common';
import { buildServerCapabilities } from '@btwld/mcp-common';
import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
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
      capabilities: capabilities as ServerOptions['capabilities'],
      ...(options.description ? { instructions: options.description } : {}),
    },
  );

  return mcpServer;
}
