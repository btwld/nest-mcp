import {
  MCP_PROMPT_METADATA,
  MCP_RESOURCE_METADATA,
  MCP_RESOURCE_TEMPLATE_METADATA,
  MCP_TOOL_METADATA,
} from '@btwld/mcp-common';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, type ModulesContainer } from '@nestjs/core';
import type { McpRegistryService } from './registry.service';

@Injectable()
export class McpScannerService implements OnModuleInit {
  private readonly logger = new Logger(McpScannerService.name);

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly registry: McpRegistryService,
  ) {}

  onModuleInit(): void {
    this.scan();
  }

  private scan(): void {
    for (const [, moduleRef] of this.modulesContainer) {
      for (const [, wrapper] of moduleRef.providers) {
        const instance = wrapper?.instance;
        if (!instance || !instance.constructor) continue;

        if (this.hasAnyMcpDecorator(instance)) {
          this.registry.registerProvider(instance);
        }
      }
    }

    this.logger.log(
      `Scan complete: ${this.registry.getAllTools().length} tools, ` +
        `${this.registry.getAllResources().length} resources, ` +
        `${this.registry.getAllResourceTemplates().length} templates, ` +
        `${this.registry.getAllPrompts().length} prompts`,
    );
  }

  private hasAnyMcpDecorator(instance: unknown): boolean {
    const prototype = Object.getPrototypeOf(instance);
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );

    for (const methodName of methodNames) {
      if (
        Reflect.getMetadata(MCP_TOOL_METADATA, prototype, methodName) ||
        Reflect.getMetadata(MCP_RESOURCE_METADATA, prototype, methodName) ||
        Reflect.getMetadata(MCP_RESOURCE_TEMPLATE_METADATA, prototype, methodName) ||
        Reflect.getMetadata(MCP_PROMPT_METADATA, prototype, methodName)
      ) {
        return true;
      }
    }

    return false;
  }
}
