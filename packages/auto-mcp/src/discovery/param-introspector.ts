/**
 * NestJS encodes per-handler parameter metadata under the key
 * `'__routeArguments__'` (`ROUTE_ARGS_METADATA`). The shape is:
 *
 *   Reflect.getMetadata('__routeArguments__', controller, methodName)
 *     => { [`${RouteParamtypes}:${index}`]: { index, data, pipes, factory? } }
 *
 * The numeric `RouteParamtypes` are (from `@nestjs/common/enums/route-paramtypes.enum.ts`):
 *   REQUEST=0  RESPONSE=1  NEXT=2  BODY=3  QUERY=4  PARAM=5  HEADERS=6
 *   SESSION=7  FILE=8  FILES=9  HOST=10  IP=11  RAW_BODY=12  (custom decorators set `factory`)
 *
 * Only BODY/QUERY/PARAM/HEADERS are mappable to MCP tool inputs in v1.
 */

export const ROUTE_ARGS_METADATA = '__routeArguments__';
export const PARAMTYPES_METADATA = 'design:paramtypes';

export const RouteParamtypes = {
  REQUEST: 0,
  RESPONSE: 1,
  NEXT: 2,
  BODY: 3,
  QUERY: 4,
  PARAM: 5,
  HEADERS: 6,
  SESSION: 7,
  FILE: 8,
  FILES: 9,
  HOST: 10,
  IP: 11,
  RAW_BODY: 12,
} as const;

export type ParamKind =
  | 'body'
  | 'query'
  | 'param'
  | 'headers'
  | 'request'
  | 'response'
  | 'next'
  | 'session'
  | 'host'
  | 'ip'
  | 'file'
  | 'unsupported';

export interface RouteParamMeta {
  index: number;
  data?: string | number | object;
  pipes?: unknown[];
  factory?: (...args: unknown[]) => unknown;
}

export interface ResolvedParam {
  index: number;
  kind: ParamKind;
  /** For BODY/QUERY/PARAM/HEADERS: the optional sub-key (e.g., `id` in `@Param('id')`). */
  data?: string;
  /** Class type from `design:paramtypes` if available. */
  metaType?: unknown;
  hasPipes: boolean;
  hasCustomFactory: boolean;
}

const PARAM_KIND_BY_NUMERIC: Record<number, ParamKind> = {
  [RouteParamtypes.REQUEST]: 'request',
  [RouteParamtypes.RESPONSE]: 'response',
  [RouteParamtypes.NEXT]: 'next',
  [RouteParamtypes.BODY]: 'body',
  [RouteParamtypes.QUERY]: 'query',
  [RouteParamtypes.PARAM]: 'param',
  [RouteParamtypes.HEADERS]: 'headers',
  [RouteParamtypes.SESSION]: 'session',
  [RouteParamtypes.FILE]: 'file',
  [RouteParamtypes.FILES]: 'file',
  [RouteParamtypes.HOST]: 'host',
  [RouteParamtypes.IP]: 'ip',
  [RouteParamtypes.RAW_BODY]: 'body',
};

/**
 * Decode the `__routeArguments__` map for a single handler. Returns one entry
 * per positional argument the controller method accepts, sorted by index.
 */
export function introspectParams(controller: object, methodName: string): ResolvedParam[] {
  const argsMeta =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller.constructor, methodName) as
      | Record<string, RouteParamMeta>
      | undefined) ?? {};
  const prototype = Object.getPrototypeOf(controller);
  const paramTypes =
    (Reflect.getMetadata(PARAMTYPES_METADATA, prototype, methodName) as unknown[]) ?? [];

  const results: ResolvedParam[] = [];
  for (const [key, meta] of Object.entries(argsMeta)) {
    const [typeStr] = key.split(':');
    const typeNum = Number(typeStr);
    const kind: ParamKind =
      meta.factory !== undefined
        ? 'unsupported' // custom decorators with a factory: cannot synthesize input
        : (PARAM_KIND_BY_NUMERIC[typeNum] ?? 'unsupported');

    results.push({
      index: meta.index,
      kind,
      data: typeof meta.data === 'string' ? meta.data : undefined,
      metaType: paramTypes[meta.index],
      hasPipes: Array.isArray(meta.pipes) && meta.pipes.length > 0,
      hasCustomFactory: meta.factory !== undefined,
    });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}
