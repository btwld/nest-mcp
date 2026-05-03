import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type {
  ElicitationRecord,
  ElicitationResultRecord,
} from '../interfaces/elicitation.interface';
import { MemoryElicitationStore } from './memory-elicitation.store';

const baseRecord = (overrides: Partial<ElicitationRecord> = {}): ElicitationRecord => ({
  elicitationId: 'eid-1',
  sessionId: 'sess-1',
  status: 'pending',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

describe('MemoryElicitationStore', () => {
  it('round-trips a stored elicitation by id', async () => {
    const store = new MemoryElicitationStore();
    const record = baseRecord();
    await store.storeElicitation(record);
    expect(await store.getElicitation('eid-1')).toEqual(record);
  });

  it('returns undefined for unknown ids', async () => {
    const store = new MemoryElicitationStore();
    expect(await store.getElicitation('missing')).toBeUndefined();
  });

  it('purges and returns undefined when an elicitation is past expiry', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(baseRecord({ expiresAt: new Date(Date.now() - 1) }));
    expect(await store.getElicitation('eid-1')).toBeUndefined();
  });

  it('updateElicitation merges partial updates', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(baseRecord());
    await store.updateElicitation('eid-1', { status: 'complete' });
    const updated = await store.getElicitation('eid-1');
    expect(updated?.status).toBe('complete');
  });

  it('storeResult marks the originating record complete', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(baseRecord());
    const result: ElicitationResultRecord = {
      elicitationId: 'eid-1',
      success: true,
      action: 'confirm',
      completedAt: new Date(),
    };
    await store.storeResult(result);
    expect((await store.getElicitation('eid-1'))?.status).toBe('complete');
    expect(await store.getResult('eid-1')).toEqual(result);
  });

  it('findResultByUserAndType uses the user+type index', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(
      baseRecord({ userId: 'user-1', metadata: { type: 'api-key' } }),
    );
    const result: ElicitationResultRecord = {
      elicitationId: 'eid-1',
      success: true,
      action: 'confirm',
      completedAt: new Date(),
      userId: 'user-1',
      type: 'api-key',
    };
    await store.storeResult(result);
    expect(await store.findResultByUserAndType('user-1', 'api-key')).toEqual(result);
    expect(await store.findResultByUserAndType('user-1', 'other')).toBeUndefined();
    expect(await store.findResultByUserAndType('other-user', 'api-key')).toBeUndefined();
  });

  it('removeElicitation drops record, result, and index entry', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(
      baseRecord({ userId: 'u', metadata: { type: 't' } }),
    );
    await store.storeResult({
      elicitationId: 'eid-1',
      success: true,
      action: 'confirm',
      completedAt: new Date(),
      userId: 'u',
      type: 't',
    });
    await store.removeElicitation('eid-1');
    expect(await store.getElicitation('eid-1')).toBeUndefined();
    expect(await store.getResult('eid-1')).toBeUndefined();
    expect(await store.findResultByUserAndType('u', 't')).toBeUndefined();
  });

  it('getElicitationsBySession excludes expired and other-session records', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(baseRecord({ elicitationId: 'a', sessionId: 's1' }));
    await store.storeElicitation(baseRecord({ elicitationId: 'b', sessionId: 's2' }));
    await store.storeElicitation(
      baseRecord({
        elicitationId: 'c',
        sessionId: 's1',
        expiresAt: new Date(Date.now() - 1),
      }),
    );
    const results = await store.getElicitationsBySession('s1');
    expect(results.map((r) => r.elicitationId)).toEqual(['a']);
  });

  it('cleanupExpired returns the purged count', async () => {
    const store = new MemoryElicitationStore();
    await store.storeElicitation(baseRecord({ elicitationId: 'live' }));
    await store.storeElicitation(
      baseRecord({ elicitationId: 'gone', expiresAt: new Date(Date.now() - 1) }),
    );
    expect(await store.cleanupExpired()).toBe(1);
    expect(await store.getElicitation('live')).toBeDefined();
  });
});
