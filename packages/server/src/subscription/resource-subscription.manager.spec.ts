import 'reflect-metadata';
import { ResourceSubscriptionManager } from './resource-subscription.manager';

function createMockServer() {
  return {
    server: {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
}

describe('ResourceSubscriptionManager', () => {
  let manager: ResourceSubscriptionManager;

  beforeEach(() => {
    manager = new ResourceSubscriptionManager();
  });

  it('notifies subscriber when resource is updated', async () => {
    const server = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server);

    await manager.notifyResourceUpdated('file:///a.txt');

    expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'file:///a.txt' });
  });

  it('does not notify after unsubscribe', async () => {
    const server = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server);
    manager.unsubscribe('session-1', 'file:///a.txt');

    await manager.notifyResourceUpdated('file:///a.txt');

    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it('unsubscribe returns false for non-existent subscription', () => {
    expect(manager.unsubscribe('session-1', 'file:///a.txt')).toBe(false);
  });

  it('unsubscribe returns true for existing subscription', () => {
    const server = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server);
    expect(manager.unsubscribe('session-1', 'file:///a.txt')).toBe(true);
  });

  it('removeSession clears all subscriptions for that session', async () => {
    const server = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server);
    manager.subscribe('session-1', 'file:///b.txt', server);

    manager.removeSession('session-1');

    await manager.notifyResourceUpdated('file:///a.txt');
    await manager.notifyResourceUpdated('file:///b.txt');

    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it('removeSession does not affect other sessions', async () => {
    const server1 = createMockServer();
    const server2 = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server1);
    manager.subscribe('session-2', 'file:///a.txt', server2);

    manager.removeSession('session-1');

    await manager.notifyResourceUpdated('file:///a.txt');

    expect(server1.server.sendResourceUpdated).not.toHaveBeenCalled();
    expect(server2.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'file:///a.txt' });
  });

  it('notifies all sessions subscribed to the same URI', async () => {
    const server1 = createMockServer();
    const server2 = createMockServer();
    manager.subscribe('session-1', 'file:///a.txt', server1);
    manager.subscribe('session-2', 'file:///a.txt', server2);

    await manager.notifyResourceUpdated('file:///a.txt');

    expect(server1.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'file:///a.txt' });
    expect(server2.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'file:///a.txt' });
  });

  it('notifyResourceUpdated with no subscribers does not error', async () => {
    await expect(manager.notifyResourceUpdated('file:///nothing.txt')).resolves.not.toThrow();
  });

  it('catches errors from individual session notifications', async () => {
    const server1 = createMockServer();
    const server2 = createMockServer();
    (server1.server.sendResourceUpdated as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('transport closed'),
    );

    manager.subscribe('session-1', 'file:///a.txt', server1);
    manager.subscribe('session-2', 'file:///a.txt', server2);

    await expect(manager.notifyResourceUpdated('file:///a.txt')).resolves.not.toThrow();
    expect(server2.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'file:///a.txt' });
  });
});
