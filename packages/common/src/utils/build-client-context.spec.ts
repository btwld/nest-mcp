import { describe, expect, it } from 'vitest';
import { McpTransportType } from '../interfaces/mcp-transport.interface';
import { buildClientContext, parseBetaHeaders } from './build-client-context';

describe('parseBetaHeaders', () => {
  it('returns undefined when header is absent', () => {
    expect(parseBetaHeaders(undefined)).toBeUndefined();
  });

  it('splits a comma-separated string value', () => {
    expect(parseBetaHeaders('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace around tokens', () => {
    expect(parseBetaHeaders('  x  ,  y  ')).toEqual(['x', 'y']);
  });

  it('flattens a string array input', () => {
    expect(parseBetaHeaders(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when only empty tokens', () => {
    expect(parseBetaHeaders('  ,  ')).toBeUndefined();
  });
});

describe('buildClientContext', () => {
  it('returns only transport when no request supplied (STDIO case)', () => {
    const ctx = buildClientContext({ transport: McpTransportType.STDIO });
    expect(ctx).toEqual({ transport: McpTransportType.STDIO });
  });

  it('extracts anthropic-beta header from Node-style lowercase headers', () => {
    const ctx = buildClientContext({
      transport: McpTransportType.STREAMABLE_HTTP,
      request: { headers: { 'anthropic-beta': 'advanced-tool-use-2025-11-20' } },
    });
    expect(ctx.betaHeaders).toEqual(['advanced-tool-use-2025-11-20']);
  });

  it('falls back to the title-cased header name if lowercase is missing', () => {
    const ctx = buildClientContext({
      transport: McpTransportType.STREAMABLE_HTTP,
      request: { headers: { 'Anthropic-Beta': 'feature-a' } },
    });
    expect(ctx.betaHeaders).toEqual(['feature-a']);
  });

  it('parses multiple comma-separated beta tokens', () => {
    const ctx = buildClientContext({
      transport: McpTransportType.STREAMABLE_HTTP,
      request: { headers: { 'anthropic-beta': 'a, b, c' } },
    });
    expect(ctx.betaHeaders).toEqual(['a', 'b', 'c']);
  });

  it('passes clientInfo and model through when provided', () => {
    const ctx = buildClientContext({
      transport: McpTransportType.SSE,
      clientInfo: { name: 'client', version: '1.0.0' },
      model: 'claude-opus-4-7',
    });
    expect(ctx.clientInfo).toEqual({ name: 'client', version: '1.0.0' });
    expect(ctx.model).toBe('claude-opus-4-7');
  });

  it('omits betaHeaders key when no header is present', () => {
    const ctx = buildClientContext({
      transport: McpTransportType.SSE,
      request: { headers: {} },
    });
    expect('betaHeaders' in ctx).toBe(false);
  });
});
