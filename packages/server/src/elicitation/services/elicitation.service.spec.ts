import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ELICITATION_OPTIONS,
  type ResolvedElicitationOptions,
} from '../interfaces/elicitation-options.interface';
import { MemoryElicitationStore } from '../stores/memory-elicitation.store';
import {
  type CompletionNotifierRegistry,
  ElicitationCancelledError,
  ElicitationService,
} from './elicitation.service';

const makeOptions = (
  overrides: Partial<ResolvedElicitationOptions> = {},
): ResolvedElicitationOptions => ({
  serverUrl: 'https://api.example.com',
  ...DEFAULT_ELICITATION_OPTIONS,
  ...overrides,
});

describe('ElicitationService', () => {
  let store: MemoryElicitationStore;
  let registry: CompletionNotifierRegistry;
  let service: ElicitationService;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemoryElicitationStore();
    registry = new Map();
    service = new ElicitationService(store, makeOptions(), registry);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('createElicitation persists a pending record and returns its id', async () => {
    const id = await service.createElicitation({ sessionId: 's1' });
    const record = await service.getElicitation(id);
    expect(record).toMatchObject({ elicitationId: id, sessionId: 's1', status: 'pending' });
  });

  it('uses the per-call ttlMs override when provided', async () => {
    const id = await service.createElicitation({ sessionId: 's1', ttlMs: 1_000 });
    const record = await service.getElicitation(id);
    if (!record) throw new Error('expected record to exist');
    const window = record.expiresAt.getTime() - record.createdAt.getTime();
    expect(window).toBe(1_000);
  });

  it('buildElicitationUrl appends path and query params', () => {
    const url = service.buildElicitationUrl('abc', 'api-key', { token: 'xyz' });
    expect(url).toBe('https://api.example.com/elicitation/abc/api-key?token=xyz');
  });

  it('strips a trailing slash on serverUrl', () => {
    const trimmed = new ElicitationService(
      store,
      makeOptions({ serverUrl: 'https://api.example.com/' }),
      registry,
    );
    expect(trimmed.buildElicitationUrl('abc')).toBe('https://api.example.com/elicitation/abc');
  });

  it('completeElicitation persists the result and fires the registered notifier', async () => {
    const id = await service.createElicitation({ sessionId: 's1' });
    const notifier = vi.fn().mockResolvedValue(undefined);
    service.registerCompletionNotifier(id, notifier);

    const fired = await service.completeElicitation({
      elicitationId: id,
      success: true,
      action: 'confirm',
      data: { apiKey: 'sk-test' },
    });

    expect(fired).toBe(true);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect((await service.getResult(id))?.data).toEqual({ apiKey: 'sk-test' });
    expect(registry.has(id)).toBe(false);
  });

  it('completeElicitation returns false for an unknown id', async () => {
    expect(
      await service.completeElicitation({
        elicitationId: 'missing',
        success: false,
        action: 'cancel',
      }),
    ).toBe(false);
  });

  it('completeElicitation refuses to overwrite an already-complete record', async () => {
    const id = await service.createElicitation({ sessionId: 's1' });
    await service.completeElicitation({ elicitationId: id, success: true, action: 'confirm' });
    expect(
      await service.completeElicitation({ elicitationId: id, success: false, action: 'cancel' }),
    ).toBe(false);
  });

  it('findResultByUserAndType bridges through the store', async () => {
    const id = await service.createElicitation({
      sessionId: 's1',
      userId: 'user-1',
      metadata: { type: 'api-key' },
    });
    await service.completeElicitation({ elicitationId: id, success: true, action: 'confirm' });
    expect(await service.findResultByUserAndType('user-1', 'api-key')).toMatchObject({
      elicitationId: id,
      success: true,
    });
  });

  it('runs cleanupExpired on the configured interval', async () => {
    const cleanupSpy = vi.spyOn(store, 'cleanupExpired');
    vi.advanceTimersByTime(DEFAULT_ELICITATION_OPTIONS.cleanupIntervalMs + 1);
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('removeElicitation purges store record and notifier registration', async () => {
    const id = await service.createElicitation({ sessionId: 's1' });
    service.registerCompletionNotifier(id, async () => {});
    await service.removeElicitation(id);
    expect(await service.getElicitation(id)).toBeUndefined();
    expect(registry.has(id)).toBe(false);
  });

  it('logs and recovers when a notifier callback rejects', async () => {
    const id = await service.createElicitation({ sessionId: 's1' });
    service.registerCompletionNotifier(id, async () => {
      throw new Error('downstream offline');
    });
    const fired = await service.completeElicitation({
      elicitationId: id,
      success: true,
      action: 'confirm',
    });
    expect(fired).toBe(false);
    expect(registry.has(id)).toBe(true);
  });

  describe('startUrlElicitation', () => {
    it('returns id, url, and a promise that resolves on completion', async () => {
      const handle = await service.startUrlElicitation({
        sessionId: 's1',
        userId: 'u1',
        path: 'api-key',
        metadata: { type: 'api-key' },
      });
      expect(handle.url).toBe(
        `https://api.example.com/elicitation/${handle.elicitationId}/api-key`,
      );

      const wait = handle.waitForCompletion();
      await service.completeElicitation({
        elicitationId: handle.elicitationId,
        success: true,
        action: 'confirm',
        data: { apiKey: 'sk-test' },
      });
      const result = await wait;
      expect(result.data).toEqual({ apiKey: 'sk-test' });
    });

    it('rejects with ElicitationCancelledError when user cancels', async () => {
      const handle = await service.startUrlElicitation({ sessionId: 's1' });
      const wait = handle.waitForCompletion();
      await service.completeElicitation({
        elicitationId: handle.elicitationId,
        success: false,
        action: 'cancel',
      });
      await expect(wait).rejects.toBeInstanceOf(ElicitationCancelledError);
    });

    it('rejects when the abort signal fires before completion', async () => {
      const handle = await service.startUrlElicitation({ sessionId: 's1' });
      const controller = new AbortController();
      const wait = handle.waitForCompletion({ signal: controller.signal });
      controller.abort();
      await expect(wait).rejects.toThrow('Elicitation aborted');
      // Notifier should have been removed.
      expect(registry.has(handle.elicitationId)).toBe(false);
    });

    it('rejects synchronously when the abort signal is already aborted', async () => {
      const handle = await service.startUrlElicitation({ sessionId: 's1' });
      const controller = new AbortController();
      controller.abort();
      await expect(handle.waitForCompletion({ signal: controller.signal })).rejects.toThrow(
        'Elicitation aborted',
      );
    });

    it('rejects with timeout when waitForCompletion exceeds the deadline', async () => {
      const handle = await service.startUrlElicitation({ sessionId: 's1' });
      const wait = handle.waitForCompletion({ timeoutMs: 500 });
      vi.advanceTimersByTime(501);
      await expect(wait).rejects.toThrow('Elicitation timed out');
      expect(registry.has(handle.elicitationId)).toBe(false);
    });

    it('defaults the URL path to api-key', async () => {
      const handle = await service.startUrlElicitation({ sessionId: 's1' });
      expect(handle.url).toMatch(/\/api-key$/);
    });
  });
});
