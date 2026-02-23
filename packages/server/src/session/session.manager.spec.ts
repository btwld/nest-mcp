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
    expect(session!.id).toBe('sess-1');
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
    expect(session!.lastActivityAt).toBe(createTime + 5000);
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
});
