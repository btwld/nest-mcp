import { describe, expect, it } from 'vitest';
import type { NormalizedRequest } from '../interfaces/openapi-mcp-options.interface';
import { applyAuth } from './auth';

function makeReq(): NormalizedRequest {
  return {
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: {},
  };
}

describe('applyAuth', () => {
  it('does nothing for type: none', async () => {
    const req = await applyAuth(makeReq(), { type: 'none' });
    expect(req.headers).toEqual({});
  });

  it('adds bearer token', async () => {
    const req = await applyAuth(makeReq(), { type: 'bearer', token: 'abc' });
    expect(req.headers.authorization).toBe('Bearer abc');
  });

  it('resolves token-provider functions', async () => {
    const req = await applyAuth(makeReq(), {
      type: 'bearer',
      token: async () => 'dynamic',
    });
    expect(req.headers.authorization).toBe('Bearer dynamic');
  });

  it('does not overwrite an existing authorization header', async () => {
    const req = makeReq();
    req.headers.authorization = 'Bearer existing';
    await applyAuth(req, { type: 'bearer', token: 'new' });
    expect(req.headers.authorization).toBe('Bearer existing');
  });

  it('adds api key in header', async () => {
    const req = await applyAuth(makeReq(), {
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
      value: 'secret',
    });
    expect(req.headers['x-api-key']).toBe('secret');
  });

  it('adds api key in query', async () => {
    const req = await applyAuth(makeReq(), {
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
      value: 'abc',
    });
    expect(req.url).toBe('https://api.example.com/x?api_key=abc');
  });

  it('encodes basic auth', async () => {
    const req = await applyAuth(makeReq(), {
      type: 'basic',
      username: 'u',
      password: 'p',
    });
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('runs custom auth functions', async () => {
    const req = await applyAuth(makeReq(), {
      type: 'custom',
      apply: (r) => ({ ...r, headers: { ...r.headers, 'x-custom': 'yes' } }),
    });
    expect(req.headers['x-custom']).toBe('yes');
  });
});
