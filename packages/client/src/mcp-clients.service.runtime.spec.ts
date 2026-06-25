import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable connect behavior so we can exercise success, slow-concurrent, and failure paths.
const hooks = vi.hoisted(() => ({
  connect: () => Promise.resolve() as Promise<void>,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(() => hooks.connect()),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
  })),
}));

vi.mock('./transport/client-transport.factory', () => ({
  createClientTransport: vi.fn().mockReturnValue({
    onclose: null,
    onerror: null,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import type { McpClientStreamableHttpConnection } from './interfaces/client-options.interface';
import { McpClientsService } from './mcp-clients.service';

function conn(name: string): McpClientStreamableHttpConnection {
  return { name, transport: 'streamable-http', url: `https://example.test/${name}/mcp` };
}

describe('McpClientsService — runtime registry', () => {
  beforeEach(() => {
    hooks.connect = () => Promise.resolve();
  });

  describe('addConnection', () => {
    it('creates, connects, and registers a new client', async () => {
      const service = new McpClientsService([]);

      const client = await service.addConnection(conn('alpha'));

      expect(client.name).toBe('alpha');
      expect(client.isConnected()).toBe(true);
      expect(service.has('alpha')).toBe(true);
      expect(service.getClient('alpha')).toBe(client);
      expect(service.getClients()).toHaveLength(1);
    });

    it('is idempotent — returns the same connected instance without creating a second', async () => {
      const service = new McpClientsService([]);

      const first = await service.addConnection(conn('alpha'));
      const second = await service.addConnection(conn('alpha'));

      expect(second).toBe(first);
      expect(service.getClients()).toHaveLength(1);
    });

    it('dedupes concurrent first-connects for the same name to a single client', async () => {
      const service = new McpClientsService([]);
      let release!: () => void;
      hooks.connect = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });

      const p1 = service.addConnection(conn('alpha'));
      const p2 = service.addConnection(conn('alpha'));
      release();
      const [c1, c2] = await Promise.all([p1, p2]);

      expect(c1).toBe(c2);
      expect(service.getClients()).toHaveLength(1);
    });

    it('replaces a stale (disconnected) client with a fresh connection', async () => {
      const service = new McpClientsService([]);

      const stale = await service.addConnection(conn('alpha'));
      await stale.disconnect();
      expect(stale.isConnected()).toBe(false);

      const fresh = await service.addConnection(conn('alpha'));

      expect(fresh).not.toBe(stale);
      expect(fresh.isConnected()).toBe(true);
      expect(service.getClients()).toHaveLength(1);
    });

    it('does NOT register a client whose connect rejects, and propagates the error', async () => {
      const service = new McpClientsService([]);
      hooks.connect = () => Promise.reject(new Error('upstream down'));

      await expect(service.addConnection(conn('alpha'))).rejects.toThrow('upstream down');
      expect(service.has('alpha')).toBe(false);
      expect(service.getClients()).toHaveLength(0);
    });
  });

  describe('getOrCreate', () => {
    it('is an alias for addConnection', async () => {
      const service = new McpClientsService([]);

      const a = await service.getOrCreate(conn('alpha'));
      const b = await service.getOrCreate(conn('alpha'));

      expect(b).toBe(a);
      expect(service.getClients()).toHaveLength(1);
    });
  });

  describe('removeConnection', () => {
    it('disconnects and unregisters the client', async () => {
      const service = new McpClientsService([]);
      const client = await service.addConnection(conn('alpha'));

      await service.removeConnection('alpha');

      expect(client.isConnected()).toBe(false);
      expect(service.has('alpha')).toBe(false);
      expect(service.getClients()).toHaveLength(0);
    });

    it('is a no-op for an unknown name', async () => {
      const service = new McpClientsService([]);
      await expect(service.removeConnection('ghost')).resolves.toBeUndefined();
    });
  });

  describe('collection identity', () => {
    it('mutates the registered array in place so getClients() references stay valid', async () => {
      const service = new McpClientsService([]);
      const ref = service.getClients();

      await service.addConnection(conn('alpha'));
      await service.removeConnection('alpha');

      expect(service.getClients()).toBe(ref);
    });
  });
});
