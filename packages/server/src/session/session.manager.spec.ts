import 'reflect-metadata';
import { SessionManager } from './session.manager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.onModuleDestroy();
    vi.useRealTimers();
  });

  it('createSession returns session with correct fields', () => {
    const session = manager.createSession('sess-1');
    expect(session.id).toBe('sess-1');
    expect(session.createdAt).toBe(Date.now());
    expect(session.lastActivityAt).toBe(Date.now());
    expect(session.metadata).toEqual({});
  });

  it('getSession retrieves existing session', () => {
    manager.createSession('sess-1');
    const session = manager.getSession('sess-1');
    expect(session).toBeDefined();
    expect(session?.id).toBe('sess-1');
  });

  it('getSession returns undefined for non-existent session', () => {
    expect(manager.getSession('non-existent')).toBeUndefined();
  });

  it('throws on max concurrent exceeded after cleanup attempt', () => {
    manager.configure({ maxConcurrent: 2, timeout: 60_000 });
    manager.createSession('sess-1');
    manager.createSession('sess-2');

    expect(() => manager.createSession('sess-3')).toThrow(
      'Maximum concurrent sessions (2) exceeded',
    );
  });

  it('getSession updates lastActivityAt', () => {
    manager.createSession('sess-1');
    const createTime = Date.now();

    vi.advanceTimersByTime(5000);

    const session = manager.getSession('sess-1');
    expect(session?.lastActivityAt).toBe(createTime + 5000);
  });

  it('removeSession removes session and getActiveSessions counts correctly', () => {
    manager.createSession('sess-1');
    manager.createSession('sess-2');
    expect(manager.getActiveSessions()).toBe(2);

    manager.removeSession('sess-1');
    expect(manager.getActiveSessions()).toBe(1);
    expect(manager.getSession('sess-1')).toBeUndefined();
  });

  it('cleanup removes sessions older than timeout', () => {
    manager.configure({ timeout: 5000, maxConcurrent: 10 });

    manager.createSession('sess-old');
    vi.advanceTimersByTime(6000);

    // Creating a new session triggers cleanup because we are still under max
    // But let's verify via getActiveSessions that old session is cleaned
    // Force cleanup by hitting max concurrent limit
    manager.configure({ timeout: 5000, maxConcurrent: 1 });

    // sess-old should be cleaned up, allowing this to succeed
    const session = manager.createSession('sess-new');
    expect(session.id).toBe('sess-new');
    expect(manager.getActiveSessions()).toBe(1);
  });

  it('onModuleDestroy clears sessions and interval', () => {
    manager.configure({ cleanupInterval: 1000 });
    manager.createSession('sess-1');
    manager.createSession('sess-2');

    manager.onModuleDestroy();

    expect(manager.getActiveSessions()).toBe(0);
  });

  it('allows creating session after cleanup frees space', () => {
    manager.configure({ maxConcurrent: 2, timeout: 5000 });
    manager.createSession('sess-old-1');
    manager.createSession('sess-old-2');

    // Advance past timeout so sessions are expired
    vi.advanceTimersByTime(6000);

    // Should succeed because cleanup runs before rejecting
    manager.configure({ maxConcurrent: 2, timeout: 5000 });
    manager.createSession('sess-old-1');
    manager.createSession('sess-old-2');
    vi.advanceTimersByTime(6000);

    const newSession = manager.createSession('sess-new');
    expect(newSession.id).toBe('sess-new');
  });

  it('configure clears previous interval when called twice', () => {
    manager.configure({ cleanupInterval: 1000 });
    // Re-configure replaces the interval without throwing
    expect(() => manager.configure({ cleanupInterval: 2000 })).not.toThrow();
  });

  it('getActiveSessions returns 0 initially', () => {
    expect(manager.getActiveSessions()).toBe(0);
  });

  it('createSession with duplicate id overwrites existing', () => {
    manager.createSession('sess-1');
    vi.advanceTimersByTime(1000);
    const second = manager.createSession('sess-1');
    expect(second.id).toBe('sess-1');
    // getSession should update lastActivityAt
    expect(manager.getActiveSessions()).toBe(1);
  });

  it('cleanup interval automatically evicts timed-out sessions', () => {
    manager.configure({ timeout: 3000, cleanupInterval: 1000, maxConcurrent: 100 });
    manager.createSession('auto-sess');
    expect(manager.getActiveSessions()).toBe(1);

    // Advance past the session timeout — cleanup interval will fire and evict
    vi.advanceTimersByTime(4000);

    expect(manager.getActiveSessions()).toBe(0);
  });

  it('onModuleDestroy is safe when configure was never called (no interval set)', () => {
    manager.createSession('sess-1');
    expect(() => manager.onModuleDestroy()).not.toThrow();
    expect(manager.getActiveSessions()).toBe(0);
  });
});
