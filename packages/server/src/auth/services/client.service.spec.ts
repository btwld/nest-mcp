import 'reflect-metadata';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { OAuthClient } from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { OAuthClientService } from './client.service';

describe('OAuthClientService', () => {
  let service: OAuthClientService;
  let store: {
    storeClient: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
    storeAuthCode: ReturnType<typeof vi.fn>;
    getAuthCode: ReturnType<typeof vi.fn>;
    removeAuthCode: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
    isTokenRevoked: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      storeClient: vi.fn().mockImplementation((client: OAuthClient) => Promise.resolve(client)),
      getClient: vi.fn(),
      storeAuthCode: vi.fn(),
      getAuthCode: vi.fn(),
      removeAuthCode: vi.fn(),
      revokeToken: vi.fn(),
      isTokenRevoked: vi.fn(),
    };

    service = new OAuthClientService(
      { jwtSecret: 'secret' } as unknown as McpAuthModuleOptions,
      store as unknown as IOAuthStore,
    );
  });

  // --- registerClient ---

  describe('registerClient', () => {
    it('generates a SHA256-based client_id of 32 hex chars', async () => {
      const client = await service.registerClient('my-app', ['http://localhost/callback']);

      expect(client.client_id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('generates a random client_secret of 64 hex chars', async () => {
      const client = await service.registerClient('my-app', ['http://localhost/callback']);

      expect(client.client_secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it('stores the client via the store', async () => {
      await service.registerClient('my-app', ['http://localhost/callback']);

      expect(store.storeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: expect.any(String),
          client_secret: expect.any(String),
          client_name: 'my-app',
          redirect_uris: ['http://localhost/callback'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      );
    });

    it('defaults grant_types to authorization_code and refresh_token', async () => {
      const client = await service.registerClient('my-app', ['http://localhost/callback']);

      expect(client.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });

    it('uses provided grant_types when given', async () => {
      const client = await service.registerClient(
        'my-app',
        ['http://localhost/callback'],
        ['client_credentials'],
      );

      expect(client.grant_types).toEqual(['client_credentials']);
    });

    it('includes created_at timestamp', async () => {
      const before = Math.floor(Date.now() / 1000);
      const client = await service.registerClient('my-app', ['http://localhost/callback']);
      const after = Math.floor(Date.now() / 1000);

      expect(client.created_at).toBeGreaterThanOrEqual(before);
      expect(client.created_at).toBeLessThanOrEqual(after);
    });

    it('generates deterministic client_id from client name', async () => {
      const client1 = await service.registerClient('my-app', ['http://localhost/callback']);
      const client2 = await service.registerClient('my-app', ['http://other/callback']);

      expect(client1.client_id).toBe(client2.client_id);
    });
  });

  // --- getClient ---

  describe('getClient', () => {
    it('delegates to store.getClient', async () => {
      const mockClient: OAuthClient = {
        client_id: 'abc',
        client_name: 'app',
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: [],
        created_at: 0,
      };
      store.getClient.mockResolvedValue(mockClient);

      const result = await service.getClient('abc');

      expect(store.getClient).toHaveBeenCalledWith('abc');
      expect(result).toBe(mockClient);
    });

    it('returns undefined when client does not exist', async () => {
      store.getClient.mockResolvedValue(undefined);

      const result = await service.getClient('nonexistent');

      expect(result).toBeUndefined();
    });
  });

  // --- validateRedirectUri ---

  describe('validateRedirectUri', () => {
    it('returns true when redirect_uri matches', async () => {
      store.getClient.mockResolvedValue({
        client_id: 'abc',
        redirect_uris: ['http://localhost/callback', 'http://other/callback'],
      } as OAuthClient);

      const result = await service.validateRedirectUri('abc', 'http://localhost/callback');

      expect(result).toBe(true);
    });

    it('returns false when redirect_uri does not match', async () => {
      store.getClient.mockResolvedValue({
        client_id: 'abc',
        redirect_uris: ['http://localhost/callback'],
      } as OAuthClient);

      const result = await service.validateRedirectUri('abc', 'http://evil.com/callback');

      expect(result).toBe(false);
    });

    it('returns false when client not found', async () => {
      store.getClient.mockResolvedValue(undefined);

      const result = await service.validateRedirectUri('nonexistent', 'http://localhost/callback');

      expect(result).toBe(false);
    });
  });
});
