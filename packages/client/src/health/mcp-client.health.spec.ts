import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClient } from '../mcp-client.service';
import { MockMcpClient } from '../testing/mock-client';
import { McpClientHealthIndicator } from './mcp-client.health';

describe('McpClientHealthIndicator', () => {
  let healthIndicator: McpClientHealthIndicator;
  let mockClient: MockMcpClient;

  beforeEach(() => {
    mockClient = new MockMcpClient('test-server');
  });

  describe('check()', () => {
    it('should return "down" when client is not connected', async () => {
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('down');
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].connected).toBe(false);
    });

    it('should return "up" when client is connected and ping succeeds', async () => {
      await mockClient.connect();
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('up');
      expect(result.connections[0].connected).toBe(true);
    });

    it('should return "down" when ping throws an error', async () => {
      await mockClient.connect();
      // Override ping to throw
      mockClient.ping = async () => {
        throw new Error('ping timeout');
      };
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('down');
      expect(result.connections[0].connected).toBe(false);
      expect(result.connections[0].error).toBe('ping timeout');
    });

    it('should include serverVersion when available', async () => {
      await mockClient.connect();
      mockClient.getServerVersion = () =>
        ({ name: 'my-server', version: '2.0.0' }) as unknown as undefined;
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.connections[0].serverVersion).toEqual({
        name: 'my-server',
        version: '2.0.0',
      });
    });

    it('should not include serverVersion when getServerVersion returns undefined', async () => {
      await mockClient.connect();
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.connections[0].serverVersion).toBeUndefined();
    });

    it('should report on multiple clients', async () => {
      const client1 = new MockMcpClient('server-a');
      const client2 = new MockMcpClient('server-b');
      await client1.connect();

      healthIndicator = new McpClientHealthIndicator([
        client1 as unknown as McpClient,
        client2 as unknown as McpClient,
      ]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('down'); // Not all connected
      expect(result.connections).toHaveLength(2);
      expect(result.connections[0].name).toBe('server-a');
      expect(result.connections[0].connected).toBe(true);
      expect(result.connections[1].name).toBe('server-b');
      expect(result.connections[1].connected).toBe(false);
    });

    it('should return "up" only when ALL clients are connected', async () => {
      const client1 = new MockMcpClient('server-a');
      const client2 = new MockMcpClient('server-b');
      await client1.connect();
      await client2.connect();

      healthIndicator = new McpClientHealthIndicator([
        client1 as unknown as McpClient,
        client2 as unknown as McpClient,
      ]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('up');
    });

    it('should return "down" when client list is empty', async () => {
      healthIndicator = new McpClientHealthIndicator([]);
      const result = await healthIndicator.check();

      expect(result.status).toBe('down');
      expect(result.connections).toHaveLength(0);
    });

    it('should include client name in the connection status', async () => {
      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      const result = await healthIndicator.check();

      expect(result.connections[0].name).toBe('test-server');
    });

    it('should not attempt ping on disconnected clients', async () => {
      const pingFn = vi.fn();
      mockClient.ping = pingFn;

      healthIndicator = new McpClientHealthIndicator([mockClient as unknown as McpClient]);
      await healthIndicator.check();

      expect(pingFn).not.toHaveBeenCalled();
    });
  });
});
