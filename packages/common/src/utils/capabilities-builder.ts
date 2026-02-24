import type { McpModuleOptions } from '../interfaces/mcp-options.interface';
import type { ServerCapabilities } from '../types/capabilities.types';

/**
 * Build server capabilities from module options and registered handlers.
 */
export function buildServerCapabilities(
  options: McpModuleOptions,
  registry: {
    hasTools: boolean;
    hasResources: boolean;
    hasResourceTemplates: boolean;
    hasPrompts: boolean;
  },
): ServerCapabilities {
  const capabilities: ServerCapabilities = {};

  // Enable capabilities if the registry has handlers OR if options explicitly declare them.
  // The options check supports gateway/dynamic patterns where tools are registered after init.
  if (registry.hasTools || options.capabilities?.tools) {
    capabilities.tools = {
      listChanged: options.capabilities?.tools?.listChanged ?? true,
    };
  }

  if (registry.hasResources || registry.hasResourceTemplates || options.capabilities?.resources) {
    capabilities.resources = {
      subscribe: options.capabilities?.resources?.subscribe ?? false,
      listChanged: options.capabilities?.resources?.listChanged ?? true,
    };
  }

  if (registry.hasPrompts || options.capabilities?.prompts) {
    capabilities.prompts = {
      listChanged: options.capabilities?.prompts?.listChanged ?? true,
    };
  }

  // Always enable logging
  capabilities.logging = {};

  return capabilities;
}
