import { McpTransportType } from '@btwld/mcp-common';
import { describe, expect, it } from 'vitest';
import { mockMcpContext } from './mock-context';

describe('mockMcpContext()', () => {
  it('returns an object', () => {
    expect(typeof mockMcpContext()).toBe('object');
  });

  it('defaults sessionId to "test-session"', () => {
    expect(mockMcpContext().sessionId).toBe('test-session');
  });

  it('defaults transport to STDIO', () => {
    expect(mockMcpContext().transport).toBe(McpTransportType.STDIO);
  });

  it('defaults metadata to an empty object', () => {
    expect(mockMcpContext().metadata).toEqual({});
  });

  it('provides a no-op reportProgress function', async () => {
    await expect(mockMcpContext().reportProgress(50, 100)).resolves.toBeUndefined();
  });

  it('provides no-op log.debug function', () => {
    expect(() => mockMcpContext().log.debug('msg')).not.toThrow();
  });

  it('provides no-op log.info function', () => {
    expect(() => mockMcpContext().log.info('msg')).not.toThrow();
  });

  it('provides no-op log.warn function', () => {
    expect(() => mockMcpContext().log.warn('msg')).not.toThrow();
  });

  it('provides no-op log.error function', () => {
    expect(() => mockMcpContext().log.error('msg')).not.toThrow();
  });

  it('applies sessionId override', () => {
    const ctx = mockMcpContext({ sessionId: 'my-session' });
    expect(ctx.sessionId).toBe('my-session');
  });

  it('applies transport override', () => {
    const ctx = mockMcpContext({ transport: McpTransportType.STREAMABLE_HTTP });
    expect(ctx.transport).toBe(McpTransportType.STREAMABLE_HTTP);
  });

  it('applies metadata override', () => {
    const meta = { userId: 'user-1' };
    const ctx = mockMcpContext({ metadata: meta });
    expect(ctx.metadata).toBe(meta);
  });

  it('each call returns a new object', () => {
    const ctx1 = mockMcpContext();
    const ctx2 = mockMcpContext();
    expect(ctx1).not.toBe(ctx2);
  });
});
