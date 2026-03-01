import 'reflect-metadata';
import type { McpExecutionContext, McpMiddleware } from '@btwld/mcp-common';
import { mockMcpContext } from '../testing/mock-context';
import { MiddlewareService } from './middleware.service';

describe('MiddlewareService', () => {
  let service: MiddlewareService;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    service = new MiddlewareService();
    ctx = mockMcpContext();
  });

  it('calls handler directly when middleware chain is empty', async () => {
    const handler = vi.fn().mockResolvedValue('result');
    const result = await service.executeChain([], ctx, {}, handler);
    expect(result).toBe('result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('single middleware calling next reaches handler', async () => {
    const handler = vi.fn().mockResolvedValue('handler-result');
    const mw: McpMiddleware = async (_ctx, _args, next) => {
      return next();
    };

    const result = await service.executeChain([mw], ctx, {}, handler);
    expect(result).toBe('handler-result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('multiple middleware execute in onion order', async () => {
    const order: string[] = [];

    const mw1: McpMiddleware = async (_ctx, _args, next) => {
      order.push('mw1-before');
      const result = await next();
      order.push('mw1-after');
      return result;
    };

    const mw2: McpMiddleware = async (_ctx, _args, next) => {
      order.push('mw2-before');
      const result = await next();
      order.push('mw2-after');
      return result;
    };

    const handler = vi.fn().mockImplementation(async () => {
      order.push('handler');
      return 'done';
    });

    const result = await service.executeChain([mw1, mw2], ctx, {}, handler);
    expect(result).toBe('done');
    expect(order).toEqual(['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
  });

  it('middleware can short-circuit by not calling next', async () => {
    const handler = vi.fn().mockResolvedValue('handler-result');
    const mw: McpMiddleware = async (_ctx, _args, _next) => {
      return 'short-circuited';
    };

    const result = await service.executeChain([mw], ctx, {}, handler);
    expect(result).toBe('short-circuited');
    expect(handler).not.toHaveBeenCalled();
  });

  it('middleware can modify context and args', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const mw: McpMiddleware = async (c, args, next) => {
      (c as unknown as Record<string, unknown>).custom = 'injected';
      (args as unknown as Record<string, unknown>).extra = 'value';
      return next();
    };

    await service.executeChain([mw], ctx, { original: true }, handler);
    expect((ctx as unknown as Record<string, unknown>).custom).toBe('injected');
  });

  it('errors propagate from middleware', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const mw: McpMiddleware = async (_ctx, _args, _next) => {
      throw new Error('middleware error');
    };

    await expect(service.executeChain([mw], ctx, {}, handler)).rejects.toThrow('middleware error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('errors propagate from handler through middleware', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler error'));
    const mw: McpMiddleware = async (_ctx, _args, next) => {
      return next();
    };

    await expect(service.executeChain([mw], ctx, {}, handler)).rejects.toThrow('handler error');
  });

  it('middleware can transform the return value from next()', async () => {
    const handler = vi.fn().mockResolvedValue('original');
    const mw: McpMiddleware = async (_ctx, _args, next) => {
      const result = await next();
      return `wrapped:${result}`;
    };

    const result = await service.executeChain([mw], ctx, {}, handler);
    expect(result).toBe('wrapped:original');
  });

  it('handler is called with no arguments', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    await service.executeChain([], ctx, { key: 'value' }, handler);
    expect(handler).toHaveBeenCalledWith();
  });

  it('three middleware chain executes in correct onion order', async () => {
    const order: string[] = [];
    const make = (name: string): McpMiddleware => async (_ctx, _args, next) => {
      order.push(`${name}-before`);
      const r = await next();
      order.push(`${name}-after`);
      return r;
    };

    const handler = vi.fn().mockImplementation(async () => {
      order.push('handler');
      return 'done';
    });

    await service.executeChain([make('a'), make('b'), make('c')], ctx, {}, handler);
    expect(order).toEqual([
      'a-before', 'b-before', 'c-before',
      'handler',
      'c-after', 'b-after', 'a-after',
    ]);
  });
});
