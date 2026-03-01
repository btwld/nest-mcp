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

    it('returns the exact same instance (identity)', () => {
      const client = makeClient('my-server');
      const service = new McpClientsService([client]);

      expect(service.getClient('my-server')).toBe(client);
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

    it('is case-sensitive — "Alpha" does not match "alpha"', () => {
      const service = new McpClientsService([makeClient('alpha')]);

      expect(() => service.getClient('Alpha')).toThrowError(
        'McpClientsService: No client named "Alpha" found.',
      );
    });

    it('returns the first client when duplicate names exist', () => {
      const first = makeClient('dup');
      const second = makeClient('dup');
      const service = new McpClientsService([first, second]);

      expect(service.getClient('dup')).toBe(first);
    });

    it('includes the missing name in the error message', () => {
      const service = new McpClientsService([makeClient('a'), makeClient('b')]);

      expect(() => service.getClient('c')).toThrowError('"c"');
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

    it('returns the same array reference on repeated calls', () => {
      const service = new McpClientsService([makeClient('x')]);

      expect(service.getClients()).toBe(service.getClients());
    });

    it('reflects all clients including those with the same name', () => {
      const a = makeClient('dup');
      const b = makeClient('dup');
      const service = new McpClientsService([a, b]);

      expect(service.getClients()).toHaveLength(2);
      expect(service.getClients()[0]).toBe(a);
      expect(service.getClients()[1]).toBe(b);
    });
  });
});
