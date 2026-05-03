import type { McpExposeOptions } from '../decorators/metadata-keys';
import type { RouteDescriptor } from '../discovery/route-descriptor';

/**
 * Default tool name: `${controllerSlug}.${methodName}` where `controllerSlug`
 * strips a trailing `Controller` suffix.
 */
export function defaultToolName(route: RouteDescriptor): string {
  if (route.expose?.name) return route.expose.name;
  const slug = route.controllerName.replace(/Controller$/, '');
  const lower = slug.charAt(0).toLowerCase() + slug.slice(1);
  return `${lower}.${route.methodName}`.slice(0, 64);
}

export function applyNamespace(name: string, namespace: string | false | undefined): string {
  if (namespace === false || namespace === undefined) return name;
  return `${namespace}.${name}`;
}

export function defaultDescription(route: RouteDescriptor): string {
  return (
    route.expose?.description ??
    `${route.verb} ${route.fullPath} (${route.controllerName}.${route.methodName})`
  );
}

export type { McpExposeOptions };
