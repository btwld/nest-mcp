import type { McpClientAuthOptions } from '../interfaces/client-options.interface';

export function applyAuthHeaders(
  requestInit: RequestInit | undefined,
  auth: McpClientAuthOptions | undefined,
): RequestInit {
  const init: RequestInit = { ...(requestInit ?? {}) };
  if (auth) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${auth.token}`);
    init.headers = headers;
  }
  return init;
}
