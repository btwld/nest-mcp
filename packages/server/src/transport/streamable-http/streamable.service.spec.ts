import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal mock for McpServer – only the `server.notification` method is exercised here.
function makeMockMcpServer(notification: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
  return {
    server: { notification },
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Build a minimal StreamableHttpService stub with only the registry events wired up.
function makeStreamableServiceStub() {
  const registryEvents = new EventEmitter();
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };

  const servers = new Map<string, ReturnType<typeof makeMockMcpServer>>();
  const registryListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];

  // Wire up notification.outbound exactly as in streamable.service.ts
  const onOutboundNotification = ({ method, params }: { method: string; params: Record<string, unknown> }) => {
    for (const server of servers.values()) {
      (server.server as unknown as { notification: (n: unknown) => Promise<void> })
        .notification({ method, params })
        .catch((err: unknown) => logger.warn(`Failed to forward notification to session: ${err}`));
    }
  };

  registryEvents.on('notification.outbound', onOutboundNotification);
  registryListeners.push({ event: 'notification.outbound', listener: onOutboundNotification as (...args: unknown[]) => void });

  return { registryEvents, servers, registryListeners, logger };
}

describe('StreamableHttpService notification.outbound forwarding', () => {
  let stub: ReturnType<typeof makeStreamableServiceStub>;

  beforeEach(() => {
    stub = makeStreamableServiceStub();
  });

  it('forwards notification to all active sessions', () => {
    const notifA = vi.fn().mockResolvedValue(undefined);
    const notifB = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session-a', makeMockMcpServer(notifA));
    stub.servers.set('session-b', makeMockMcpServer(notifB));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 'upstream::t1', status: 'completed' },
    });

    expect(notifA).toHaveBeenCalledWith({ method: 'notifications/tasks/status', params: { taskId: 'upstream::t1', status: 'completed' } });
    expect(notifB).toHaveBeenCalledWith({ method: 'notifications/tasks/status', params: { taskId: 'upstream::t1', status: 'completed' } });
  });

  it('does nothing when there are no active sessions', () => {
    expect(() =>
      stub.registryEvents.emit('notification.outbound', {
        method: 'notifications/tasks/status',
        params: { taskId: 't1', status: 'running' },
      }),
    ).not.toThrow();
  });

  it('catches and logs errors from server.notification without propagating', async () => {
    const failingNotif = vi.fn().mockRejectedValue(new Error('transport closed'));
    stub.servers.set('session-fail', makeMockMcpServer(failingNotif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't1', status: 'failed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to forward notification to session'),
    );
  });

  it('forwards to remaining sessions when one session fails', async () => {
    const failingNotif = vi.fn().mockRejectedValue(new Error('closed'));
    const successNotif = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session-fail', makeMockMcpServer(failingNotif));
    stub.servers.set('session-ok', makeMockMcpServer(successNotif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't2', status: 'completed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(successNotif).toHaveBeenCalledOnce();
    expect(stub.logger.warn).toHaveBeenCalled();
  });

  it('removes the listener from registryListeners on cleanup', () => {
    for (const { event, listener } of stub.registryListeners) {
      stub.registryEvents.removeListener(event, listener);
    }

    const notif = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session', makeMockMcpServer(notif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't1', status: 'completed' },
    });

    expect(notif).not.toHaveBeenCalled();
  });
});
