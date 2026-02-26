import 'reflect-metadata';
import type { AuthorizationCode, OAuthClient } from '../interfaces/oauth-types.interface';
import { MemoryOAuthStore } from './memory-store.service';

describe('MemoryOAuthStore', () => {
  let store: MemoryOAuthStore;

  beforeEach(() => {
    store = new MemoryOAuthStore();
  });

  // --- Clients ---

  describe('storeClient / getClient', () => {
    it('stores and retrieves a client', async () => {
      const client: OAuthClient = {
        client_id: 'abc',
        client_secret: 'secret',
        client_name: 'My App',
        redirect_uris: ['http://localhost/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        created_at: 1000,
      };

      const stored = await store.storeClient(client);
      expect(stored).toBe(client);

      const retrieved = await store.getClient('abc');
      expect(retrieved).toBe(client);
    });

    it('returns undefined for non-existent client', async () => {
      const result = await store.getClient('nonexistent');
      expect(result).toBeUndefined();
    });

    it('overwrites client with same id', async () => {
      const client1: OAuthClient = {
        client_id: 'abc',
        client_name: 'First',
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: [],
        created_at: 1000,
      };
      const client2: OAuthClient = {
        client_id: 'abc',
        client_name: 'Second',
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: [],
        created_at: 2000,
      };

      await store.storeClient(client1);
      await store.storeClient(client2);

      const retrieved = await store.getClient('abc');
      expect(retrieved?.client_name).toBe('Second');
    });
  });

  // --- Auth Codes ---

  describe('storeAuthCode / getAuthCode', () => {
    function makeAuthCode(overrides: Partial<AuthorizationCode> = {}): AuthorizationCode {
      return {
        code: 'code-123',
        client_id: 'client-1',
        user_id: 'user-1',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'read',
        expires_at: Date.now() + 300_000,
        ...overrides,
      };
    }

    it('stores and retrieves an auth code', async () => {
      const code = makeAuthCode();
      await store.storeAuthCode(code);

      const retrieved = await store.getAuthCode('code-123');
      expect(retrieved).toBe(code);
    });

    it('returns undefined for non-existent auth code', async () => {
      const result = await store.getAuthCode('nonexistent');
      expect(result).toBeUndefined();
    });

    it('returns undefined and deletes expired auth code', async () => {
      const code = makeAuthCode({ expires_at: Date.now() - 1000 });
      await store.storeAuthCode(code);

      const result = await store.getAuthCode('code-123');
      expect(result).toBeUndefined();

      // Confirm it was deleted
      const secondResult = await store.getAuthCode('code-123');
      expect(secondResult).toBeUndefined();
    });
  });

  // --- removeAuthCode ---

  describe('removeAuthCode', () => {
    it('removes a stored auth code', async () => {
      const code: AuthorizationCode = {
        code: 'remove-me',
        client_id: 'client-1',
        user_id: 'user-1',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'read',
        expires_at: Date.now() + 300_000,
      };
      await store.storeAuthCode(code);

      await store.removeAuthCode('remove-me');

      const result = await store.getAuthCode('remove-me');
      expect(result).toBeUndefined();
    });

    it('does not throw when removing non-existent code', async () => {
      await expect(store.removeAuthCode('nonexistent')).resolves.toBeUndefined();
    });
  });

  // --- Token Revocation ---

  describe('revokeToken / isTokenRevoked', () => {
    it('marks a token as revoked', async () => {
      await store.revokeToken('jti-123');

      const revoked = await store.isTokenRevoked('jti-123');
      expect(revoked).toBe(true);
    });

    it('returns false for non-revoked token', async () => {
      const revoked = await store.isTokenRevoked('jti-unknown');
      expect(revoked).toBe(false);
    });

    it('handles multiple revocations', async () => {
      await store.revokeToken('jti-1');
      await store.revokeToken('jti-2');

      expect(await store.isTokenRevoked('jti-1')).toBe(true);
      expect(await store.isTokenRevoked('jti-2')).toBe(true);
      expect(await store.isTokenRevoked('jti-3')).toBe(false);
    });
  });

  // --- Bounded Store ---

  describe('storeClient bounds', () => {
    it('throws when max clients reached', async () => {
      // Store MAX_CLIENTS (10_000) clients
      for (let i = 0; i < 10_000; i++) {
        await store.storeClient({
          client_id: `client-${i}`,
          client_name: `Client ${i}`,
          redirect_uris: [],
          token_endpoint_auth_method: 'none',
          grant_types: [],
          created_at: Date.now(),
        });
      }

      // The next one should throw
      await expect(
        store.storeClient({
          client_id: 'client-overflow',
          client_name: 'Overflow',
          redirect_uris: [],
          token_endpoint_auth_method: 'none',
          grant_types: [],
          created_at: Date.now(),
        }),
      ).rejects.toThrow('Maximum number of registered clients reached');
    });

    it('allows updating existing client when at max capacity', async () => {
      for (let i = 0; i < 10_000; i++) {
        await store.storeClient({
          client_id: `client-${i}`,
          client_name: `Client ${i}`,
          redirect_uris: [],
          token_endpoint_auth_method: 'none',
          grant_types: [],
          created_at: Date.now(),
        });
      }

      // Updating existing client should work
      const updated = await store.storeClient({
        client_id: 'client-0',
        client_name: 'Updated Client',
        redirect_uris: ['http://new'],
        token_endpoint_auth_method: 'none',
        grant_types: [],
        created_at: Date.now(),
      });

      expect(updated.client_name).toBe('Updated Client');
    });
  });

  describe('lifecycle cleanup', () => {
    it('starts and stops cleanup timer', () => {
      store.onModuleInit();
      store.onModuleDestroy();
      // Should not throw
    });

    it('cleanup removes expired auth codes', async () => {
      const expiredCode: AuthorizationCode = {
        code: 'expired-code',
        client_id: 'client-1',
        user_id: 'user-1',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'read',
        expires_at: Date.now() - 1000,
      };

      await store.storeAuthCode(expiredCode);

      // Access private cleanup method
      // biome-ignore lint/suspicious/noExplicitAny: test access to private method
      (store as any).cleanup();

      // Expired code should be cleaned up
      const result = await store.getAuthCode('expired-code');
      expect(result).toBeUndefined();
    });
  });
});
