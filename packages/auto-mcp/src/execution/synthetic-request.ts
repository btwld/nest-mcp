import type { ResolvedParam } from '../discovery/param-introspector';

export interface SyntheticHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
  params: Record<string, unknown>;
  user?: unknown;
  /** Default loopback so guards expecting a present IP do not crash. */
  ip: string;
  ips: string[];
  /** Default to `'http'`; users can wrap the executor to override. */
  protocol: 'http' | 'https';
  /** `true` when `protocol === 'https'` — kept in sync with `protocol`. */
  secure: boolean;
  hostname: string;
  /** Express-compatible header lookup. Case-insensitive. */
  get: (name: string) => string | undefined;
  header: (name: string) => string | undefined;
  /** marker so guards/middleware can detect they're running under the MCP bridge */
  __mcpBridge: true;
}

export interface SyntheticHttpResponse {
  statusCode: number;
  headersSent: boolean;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
  status: (n: number) => SyntheticHttpResponse;
  send: (b?: unknown) => SyntheticHttpResponse;
  json: (b?: unknown) => SyntheticHttpResponse;
  end: (b?: unknown) => SyntheticHttpResponse;
  /** Captured body for callers that go through `res.send()`. */
  __body: unknown;
}

/**
 * Build a synthetic HTTP req from MCP tool input and the decoded route params.
 * - `@Body()` whole: receives the input as-is (minus consumed param keys)
 * - `@Body('foo')`: receives `input.foo`
 * - `@Param('id')`: receives `input.id`
 * - `@Query()` whole: receives `input` (minus path/header keys)
 * - `@Query('limit')`: receives `input.limit`
 * - `@Headers()` whole: receives `inboundHeaders`
 * - `@Headers('x-foo')`: receives `inboundHeaders[x-foo]`
 */
export function buildSyntheticRequest(
  input: Record<string, unknown>,
  params: ResolvedParam[],
  inboundHeaders: Record<string, string>,
  user: unknown,
  toolName: string,
  fullPath: string,
  verb: string,
): SyntheticHttpRequest {
  const consumed = new Set<string>();
  const reqParams: Record<string, unknown> = {};
  const reqQuery: Record<string, unknown> = {};
  let reqBody: unknown = undefined;

  for (const param of params) {
    if (param.kind === 'param' && param.data) {
      reqParams[param.data] = input[param.data];
      consumed.add(param.data);
    }
    if (param.kind === 'query' && param.data) {
      reqQuery[param.data] = input[param.data];
      consumed.add(param.data);
    }
    if (param.kind === 'body' && param.data) {
      // The handler grabs body[data]; populate the body with that key.
      reqBody = reqBody && typeof reqBody === 'object' ? reqBody : {};
      (reqBody as Record<string, unknown>)[param.data] = input[param.data];
      consumed.add(param.data);
    }
  }

  // For "whole" body / query params, give them everything not already consumed.
  const hasWholeBody = params.some((p) => p.kind === 'body' && !p.data);
  const hasWholeQuery = params.some((p) => p.kind === 'query' && !p.data);

  if (hasWholeBody) {
    const bodyShape: Record<string, unknown> = { ...((reqBody as object | undefined) ?? {}) };
    for (const [k, v] of Object.entries(input)) {
      if (!consumed.has(k)) bodyShape[k] = v;
    }
    reqBody = bodyShape;
  }
  if (hasWholeQuery) {
    for (const [k, v] of Object.entries(input)) {
      if (!consumed.has(k)) reqQuery[k] = v;
    }
  }

  const headers: Record<string, string> = {
    'x-mcp-tool': toolName,
    ...inboundHeaders,
  };
  // Case-insensitive header lookup matches Express/Fastify `req.get(name)`.
  const get = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return undefined;
  };

  return {
    method: verb,
    url: substitutePathTokens(fullPath, reqParams),
    headers,
    body: reqBody,
    query: reqQuery,
    params: reqParams,
    user,
    ip: '127.0.0.1',
    ips: [],
    protocol: 'http',
    secure: false,
    hostname: 'localhost',
    get,
    header: get,
    __mcpBridge: true,
  };
}

export function buildSyntheticResponse(): SyntheticHttpResponse {
  const stored: Record<string, string> = {};
  const res: SyntheticHttpResponse = {
    statusCode: 200,
    headersSent: false,
    __body: undefined,
    setHeader(k, v) {
      stored[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return stored[k.toLowerCase()];
    },
    status(n) {
      res.statusCode = n;
      return res;
    },
    send(b) {
      res.__body = b;
      res.headersSent = true;
      return res;
    },
    json(b) {
      res.__body = b;
      res.headersSent = true;
      return res;
    },
    end(b) {
      if (b !== undefined) res.__body = b;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function substitutePathTokens(path: string, params: Record<string, unknown>): string {
  return path.replace(/{(\w+)}|:(\w+)/g, (_, a: string, b: string) => {
    const key = a ?? b;
    const v = params[key];
    return v === undefined ? `{${key}}` : encodeURIComponent(String(v));
  });
}
