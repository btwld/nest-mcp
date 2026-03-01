import {
  MCP_PROMPT_METADATA,
  MCP_RESOURCE_METADATA,
  MCP_RESOURCE_TEMPLATE_METADATA,
  MCP_TOOL_METADATA,
} from '@nest-mcp/common';
import type { McpModuleOptions } from '@nest-mcp/common';
import { MCP_OPTIONS } from '@nest-mcp/common';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { InjectionToken } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import {
  MCP_FEATURE_REGISTRATION,
  type McpFeatureRegistration,
} from './feature-registration.constants';
import { McpRegistryService } from './registry.service';

@Injectable()
export class McpScannerService implements OnModuleInit {
  private readonly logger = new Logger(McpScannerService.name);

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly registry: McpRegistryService,
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
  ) {}

  onModuleInit(): void {
    this.scan();
  }

  private scan(): void {
    const serverTargetedTokens = this.collectServerTargetedTokens();

    for (const [, moduleRef] of this.modulesContainer) {
      for (const [, wrapper] of moduleRef.providers) {
        const instance = wrapper?.instance;
        if (!instance || !instance.constructor) continue;

        // If this provider is explicitly targeted at a server, filter by current server
        const targetedServers = serverTargetedTokens.get(instance.constructor as InjectionToken);
        if (targetedServers && !targetedServers.includes(this.options.name)) {
          continue;
        }

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

  /** Collect all feature registrations and build: token → server names */
  private collectServerTargetedTokens(): Map<InjectionToken, string[]> {
    const map = new Map<InjectionToken, string[]>();

    for (const [, moduleRef] of this.modulesContainer) {
      for (const [key, wrapper] of moduleRef.providers) {
        if (
          typeof key === 'string' &&
          key.startsWith(MCP_FEATURE_REGISTRATION) &&
          wrapper?.instance
        ) {
          const reg = wrapper.instance as McpFeatureRegistration;
          for (const token of reg.providerTokens) {
            const existing = map.get(token) ?? [];
            existing.push(reg.serverName);
            map.set(token, existing);
          }
        }
      }
    }

    return map;
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
