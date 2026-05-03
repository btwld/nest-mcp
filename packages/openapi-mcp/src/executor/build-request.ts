import type { NormalizedRequest } from '../interfaces/openapi-mcp-options.interface';
import type { ToolDescriptor } from '../interfaces/tool-descriptor.interface';

/**
 * Build an HTTP request from a tool descriptor and the input arguments.
 * - Path tokens are replaced via `encodeURIComponent`
 * - Query params are appended as `URLSearchParams` (arrays become repeated keys)
 * - JSON body is serialized for `post|put|patch|delete`; `wrapped` body uses
 *   the `body` key, `arrayBody` uses the `items` key, otherwise body params
 *   are picked off the inputs by name.
 */
export function buildRequest(
  baseUrl: string,
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
  inboundHeaders: Record<string, string> = {},
): NormalizedRequest {
  let path = descriptor.request.pathTemplate;
  const search = new URLSearchParams();
  const headers: Record<string, string> = { ...inboundHeaders };

  const consumed = new Set<string>();

  for (const param of descriptor.parameters) {
    const value = args[param.name];
    consumed.add(param.name);
    if (value === undefined || value === null) continue;
    if (param.in === 'path') {
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      continue;
    }
    if (param.in === 'query') {
      if (Array.isArray(value)) {
        for (const v of value) search.append(param.name, String(v));
      } else {
        search.set(param.name, String(value));
      }
    }
  }

  let body: unknown;
  if (descriptor.body) {
    if (descriptor.body.arrayBody) {
      body = args.items;
      consumed.add('items');
    } else if (descriptor.body.wrapped) {
      body = args.body;
      consumed.add('body');
    } else if (descriptor.body.schema.properties) {
      const bodyShape: Record<string, unknown> = {};
      for (const key of Object.keys(descriptor.body.schema.properties as Record<string, unknown>)) {
        if (key in args) {
          bodyShape[key] = args[key];
          consumed.add(key);
        }
      }
      body = bodyShape;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
  }

  const url = new URL(joinUrl(baseUrl, path));
  for (const [k, v] of search) url.searchParams.append(k, v);

  return {
    method: descriptor.request.method,
    url: url.toString(),
    headers,
    body,
  };
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return base + path;
}
