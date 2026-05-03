import { Injectable, Logger, RequestMethod, type Type } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import {
  MCP_AUTO_CONTROLLER_METADATA,
  MCP_AUTO_EXPOSE_METADATA,
  MCP_AUTO_HIDE_METADATA,
} from '../decorators/metadata-keys';
import type { McpExposeControllerOptions, McpExposeOptions } from '../decorators/metadata-keys';
import type { AutoMcpOptions } from '../interfaces/auto-mcp-options.interface';
import { introspectParams } from './param-introspector';
import type { HttpVerb, RouteDescriptor } from './route-descriptor';

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

const VERB_BY_REQUEST_METHOD: Record<number, HttpVerb> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.ALL]: 'ALL',
};

/**
 * Walks `ModulesContainer.controllers` and emits one `RouteDescriptor` per
 * decorated route handler. Mirrors the pattern in
 * `@nest-mcp/server`'s `McpScannerService` but iterates `controllers` rather
 * than `providers`.
 */
@Injectable()
export class RouteScannerService {
  private readonly logger = new Logger(RouteScannerService.name);

  constructor(private readonly modulesContainer: ModulesContainer) {}

  scan(options: AutoMcpOptions): RouteDescriptor[] {
    const controllerFilter = options.controllers
      ? new Set(options.controllers.map((c) => c as Type))
      : null;
    const includeMatchers = compileMatchers(options.include);
    const excludeMatchers = compileMatchers(options.exclude);

    const out: RouteDescriptor[] = [];

    for (const moduleRef of this.modulesContainer.values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const instance = wrapper.instance;
        const controllerType = wrapper.metatype as Type | undefined;
        if (!instance || !controllerType) continue;
        if (controllerFilter && !controllerFilter.has(controllerType)) continue;

        const ctrlMeta: McpExposeControllerOptions =
          Reflect.getMetadata(MCP_AUTO_CONTROLLER_METADATA, controllerType) ?? {};
        if (Reflect.getMetadata(MCP_AUTO_HIDE_METADATA, controllerType)) continue;

        const mode = ctrlMeta.mode ?? options.mode ?? 'all';
        const controllerPath =
          (Reflect.getMetadata(PATH_METADATA, controllerType) as string | string[] | undefined) ??
          '';
        const prefix = Array.isArray(controllerPath) ? controllerPath[0] : controllerPath;

        const prototype = Object.getPrototypeOf(instance);
        const methodNames = Object.getOwnPropertyNames(prototype).filter(
          (n) => n !== 'constructor' && typeof prototype[n] === 'function',
        );

        for (const methodName of methodNames) {
          const handler = prototype[methodName] as object | undefined;
          if (!handler) continue;

          const isHidden = Boolean(
            Reflect.getMetadata(MCP_AUTO_HIDE_METADATA, prototype, methodName),
          );
          if (isHidden) continue;

          const expose = Reflect.getMetadata(MCP_AUTO_EXPOSE_METADATA, prototype, methodName) as
            | McpExposeOptions
            | undefined;

          if (mode === 'opt-in' && !expose) continue;

          // Nest stores PATH/METHOD metadata on the handler function itself, not on the prototype + key.
          const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
            | string
            | string[]
            | undefined;
          if (routePath === undefined) continue;
          const verbNum = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (verbNum === undefined) continue;
          const verb = VERB_BY_REQUEST_METHOD[verbNum] ?? 'GET';

          const subPath = Array.isArray(routePath) ? routePath[0] : routePath;
          const fullPath = `/${[prefix, subPath].filter(Boolean).join('/').replace(/\/+/g, '/')}`;
          const labelKey = `${controllerType.name}.${methodName}`;

          if (includeMatchers && !matchesAny(includeMatchers, labelKey, controllerType, methodName))
            continue;
          if (excludeMatchers && matchesAny(excludeMatchers, labelKey, controllerType, methodName))
            continue;

          const params = introspectParams(instance as object, methodName);
          out.push({
            controllerType,
            controllerName: controllerType.name,
            methodName,
            verb,
            fullPath,
            params,
            expose,
            isHidden: false,
            isRequestScoped: wrapper.scope === 1, // 0 = DEFAULT, 1 = REQUEST, 2 = TRANSIENT
          });
        }
      }
    }

    this.logger.log(`Discovered ${out.length} controller route(s) for MCP exposure.`);
    return out;
  }
}

type Matcher =
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: RegExp }
  | { kind: 'object'; controller: string; method?: string };

function compileMatchers(
  input: AutoMcpOptions['include'] | AutoMcpOptions['exclude'],
): Matcher[] | null {
  if (!input || input.length === 0) return null;
  return input.map((entry) => {
    if (typeof entry === 'string') return { kind: 'string', value: entry } as Matcher;
    if (entry instanceof RegExp) return { kind: 'regex', value: entry } as Matcher;
    return {
      kind: 'object',
      controller: typeof entry.controller === 'string' ? entry.controller : entry.controller.name,
      method: entry.method,
    } as Matcher;
  });
}

function matchesAny(
  matchers: Matcher[],
  labelKey: string,
  controllerType: Type,
  methodName: string,
): boolean {
  return matchers.some((m) => {
    if (m.kind === 'string') return m.value === labelKey;
    if (m.kind === 'regex') return m.value.test(labelKey);
    if (m.controller !== controllerType.name) return false;
    return m.method === undefined || m.method === methodName;
  });
}
