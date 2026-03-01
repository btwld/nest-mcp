import { describe, expect, it } from 'vitest';
import type { McpClient } from './mcp-client.service';
import { McpClientsService } from './mcp-clients.service';

function makeClient(name: string): McpClient {
  return { name } as unknown as McpClient;
}

describe('McpClientsService', () => {
  describe('getClient', () => {
    it('returns the client with the given name', () => {
      const alpha = makeClient('alpha');
      const beta = makeClient('beta');
      const service = new McpClientsService([alpha, beta]);

      expect(service.getClient('alpha')).toBe(alpha);
      expect(service.getClient('beta')).toBe(beta);
    });

    it('throws when no client matches the name', () => {
      const service = new McpClientsService([makeClient('alpha')]);

      expect(() => service.getClient('unknown')).toThrowError(
        'McpClientsService: No client named "unknown" found.',
      );
    });

    it('throws when the client list is empty', () => {
      const service = new McpClientsService([]);

      expect(() => service.getClient('anything')).toThrowError(
        'McpClientsService: No client named "anything" found.',
      );
    });
  });

  describe('getClients', () => {
    it('returns all registered clients', () => {
      const clients = [makeClient('a'), makeClient('b'), makeClient('c')];
      const service = new McpClientsService(clients);

      expect(service.getClients()).toEqual(clients);
    });

    it('returns an empty array when no clients are registered', () => {
      const service = new McpClientsService([]);

      expect(service.getClients()).toEqual([]);
    });
  });
});
