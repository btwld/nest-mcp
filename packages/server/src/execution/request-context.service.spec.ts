import { McpTransportType } from '@nest-mcp/common';
import type { McpExecutionContext } from '@nest-mcp/common';
import { describe, expect, it } from 'vitest';
import { McpRequestContextService } from './request-context.service';

describe('McpRequestContextService', () => {
  const makeCtx = (sessionId: string): McpExecutionContext => ({
    sessionId,
    transport: McpTransportType.SSE,
    reportProgress: () => Promise.resolve(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    metadata: {},
  });

  it('returns undefined outside run()', () => {
    const service = new McpRequestContextService();
    expect(service.getContext()).toBeUndefined();
  });

  it('returns context inside run()', () => {
    const service = new McpRequestContextService();
    const ctx = makeCtx('session-1');

    service.run(ctx, () => {
      expect(service.getContext()).toBe(ctx);
    });
  });

  it('returns undefined after run() completes', () => {
    const service = new McpRequestContextService();
    const ctx = makeCtx('session-2');

    service.run(ctx, () => {
      /* no-op */
    });

    expect(service.getContext()).toBeUndefined();
  });

  it('propagates through async/await chains', async () => {
    const service = new McpRequestContextService();
    const ctx = makeCtx('session-3');

    await service.run(ctx, async () => {
      await Promise.resolve();
      expect(service.getContext()).toBe(ctx);
      await Promise.resolve();
      expect(service.getContext()).toBe(ctx);
    });
  });

  it('isolates concurrent run() calls', async () => {
    const service = new McpRequestContextService();
    const ctx1 = makeCtx('session-a');
    const ctx2 = makeCtx('session-b');

    const results: Array<McpExecutionContext | undefined> = [];

    await Promise.all([
      service.run(ctx1, async () => {
        await Promise.resolve();
        results.push(service.getContext());
      }),
      service.run(ctx2, async () => {
        await Promise.resolve();
        results.push(service.getContext());
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results).toContain(ctx1);
    expect(results).toContain(ctx2);
  });

  it('nested run() shadows outer context', () => {
    const service = new McpRequestContextService();
    const outer = makeCtx('outer');
    const inner = makeCtx('inner');

    service.run(outer, () => {
      expect(service.getContext()).toBe(outer);

      service.run(inner, () => {
        expect(service.getContext()).toBe(inner);
      });

      expect(service.getContext()).toBe(outer);
    });
  });

  it('returns the value from the callback', async () => {
    const service = new McpRequestContextService();
    const ctx = makeCtx('session-val');

    const result = await service.run(ctx, async () => 42);

    expect(result).toBe(42);
  });

  it('propagates errors thrown inside run()', async () => {
    const service = new McpRequestContextService();
    const ctx = makeCtx('session-err');

    await expect(
      service.run(ctx, async () => {
        throw new Error('inner error');
      }),
    ).rejects.toThrow('inner error');
  });
});
