import { describe, expect, it } from 'vitest';
import { ExpressAdapter } from './express.adapter';
import { FastifyAdapter } from './fastify.adapter';
import { getHttpAdapter } from './adapter.factory';

describe('getHttpAdapter', () => {
  it('returns a FastifyAdapter when request has routeOptions', () => {
    const adapter = getHttpAdapter({ routeOptions: {} });
    expect(adapter).toBeInstanceOf(FastifyAdapter);
  });

  it('returns a FastifyAdapter when request has routerPath', () => {
    const adapter = getHttpAdapter({ routerPath: '/mcp' });
    expect(adapter).toBeInstanceOf(FastifyAdapter);
  });

  it('returns an ExpressAdapter for a plain Express-like request', () => {
    const adapter = getHttpAdapter({ method: 'POST', url: '/mcp' });
    expect(adapter).toBeInstanceOf(ExpressAdapter);
  });

  it('returns an ExpressAdapter for null/undefined request', () => {
    const adapter = getHttpAdapter(null);
    expect(adapter).toBeInstanceOf(ExpressAdapter);
  });

  it('caches and returns the same adapter instance for the same type', () => {
    const first = getHttpAdapter({ method: 'GET' });
    const second = getHttpAdapter({ url: '/sse' });
    expect(first).toBe(second);
  });

  it('returns different instances for express and fastify', () => {
    const express = getHttpAdapter({ method: 'GET' });
    const fastify = getHttpAdapter({ routeOptions: {} });
    expect(express).not.toBe(fastify);
  });
});
