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
        const metatype = wrapper?.metatype as (new (...args: unknown[]) => unknown) | undefined;
        const constructor = instance?.constructor ?? metatype;
        if (!constructor) continue;

        // If this provider is explicitly targeted at a server, filter by current server
        const targetedServers = serverTargetedTokens.get(constructor as InjectionToken);
        if (targetedServers && !targetedServers.includes(this.options.name)) {
          continue;
        }

        // Request/transient-scoped wrappers expose a never-constructed shell
        // object as `instance` (Nest creates it via Object.create for lazy
        // instantiation), so instance truthiness alone cannot distinguish
        // scoped providers from singletons.
        const isStatic = this.isDependencyTreeStatic(wrapper) && Boolean(instance?.constructor);

        if (isStatic && instance?.constructor) {
          if (this.hasAnyMcpDecorator(Object.getPrototypeOf(instance))) {
            this.registry.registerProvider(instance);
          }
        } else if (typeof metatype === 'function' && metatype.prototype) {
          // Scoped providers have no usable boot-time instance — register the
          // class so the executor resolves a fresh one per call.
          if (this.hasAnyMcpDecorator(metatype.prototype)) {
            this.registry.registerProviderClass(metatype);
          }
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

  /**
   * True when the wrapper's whole dependency tree is singleton-scoped (a
   * request/transient provider anywhere in the tree makes it per-request).
   * Falls back to `true` for wrapper mocks that lack the Nest API.
   */
  private isDependencyTreeStatic(wrapper: unknown): boolean {
    const candidate = wrapper as { isDependencyTreeStatic?: () => boolean };
    return typeof candidate.isDependencyTreeStatic === 'function'
      ? candidate.isDependencyTreeStatic()
      : true;
  }

  private hasAnyMcpDecorator(prototype: object): boolean {
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
