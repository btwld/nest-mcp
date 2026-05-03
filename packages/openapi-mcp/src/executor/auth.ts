import type { AuthConfig, NormalizedRequest } from '../interfaces/openapi-mcp-options.interface';

/**
 * Apply an `AuthConfig` to a normalized request. Never overwrites a header
 * that was already populated by `forwardHeaders` — the upstream-configured
 * credentials win only when no caller-supplied value exists.
 */
export async function applyAuth(
  request: NormalizedRequest,
  auth: AuthConfig | undefined,
): Promise<NormalizedRequest> {
  if (!auth || auth.type === 'none') return request;

  if (auth.type === 'bearer') {
    const token = typeof auth.token === 'function' ? await auth.token() : auth.token;
    if (!hasHeader(request, 'authorization')) {
      request.headers.authorization = `Bearer ${token}`;
    }
    return request;
  }

  if (auth.type === 'apiKey') {
    const value = typeof auth.value === 'function' ? await auth.value() : auth.value;
    if (auth.in === 'header') {
      if (!hasHeader(request, auth.name)) {
        request.headers[auth.name] = value;
      }
    } else {
      const url = new URL(request.url);
      if (!url.searchParams.has(auth.name)) {
        url.searchParams.set(auth.name, value);
        request.url = url.toString();
      }
    }
    return request;
  }

  if (auth.type === 'basic') {
    if (!hasHeader(request, 'authorization')) {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      request.headers.authorization = `Basic ${encoded}`;
    }
    return request;
  }

  if (auth.type === 'custom') {
    return auth.apply(request);
  }

  // Exhaustiveness guard: if a future variant is added to AuthConfig the compiler
  // forces us to handle it. A silently-no-op auth path is a security bug.
  const _exhaustive: never = auth;
  void _exhaustive;
  return request;
}

function hasHeader(request: NormalizedRequest, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(request.headers).some((h) => h.toLowerCase() === lower);
}
