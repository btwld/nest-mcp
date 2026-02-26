import { applyAuthHeaders } from './apply-auth-headers';

describe('applyAuthHeaders', () => {
  it('should return empty RequestInit when no auth and no requestInit', () => {
    const result = applyAuthHeaders(undefined, undefined);
    expect(result).toEqual({});
  });

  it('should pass through requestInit when no auth', () => {
    const requestInit: RequestInit = { method: 'POST' };
    const result = applyAuthHeaders(requestInit, undefined);
    expect(result).toEqual({ method: 'POST' });
  });

  it('should add Authorization header when auth is provided', () => {
    const auth = { type: 'bearer' as const, token: 'my-secret-token' };
    const result = applyAuthHeaders(undefined, auth);

    const headers = new Headers(result.headers);
    expect(headers.get('Authorization')).toBe('Bearer my-secret-token');
  });

  it('should preserve existing requestInit properties when adding auth', () => {
    const requestInit: RequestInit = { method: 'POST', body: 'data' };
    const auth = { type: 'bearer' as const, token: 'tok123' };
    const result = applyAuthHeaders(requestInit, auth);

    expect(result.method).toBe('POST');
    expect(result.body).toBe('data');
    const headers = new Headers(result.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok123');
  });

  it('should preserve existing headers and add Authorization', () => {
    const requestInit: RequestInit = {
      headers: { 'Content-Type': 'application/json' },
    };
    const auth = { type: 'bearer' as const, token: 'tok' };
    const result = applyAuthHeaders(requestInit, auth);

    const headers = new Headers(result.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  it('should not mutate the original requestInit', () => {
    const requestInit: RequestInit = { method: 'GET' };
    const auth = { type: 'bearer' as const, token: 'tok' };
    applyAuthHeaders(requestInit, auth);

    expect(requestInit.headers).toBeUndefined();
  });
});
