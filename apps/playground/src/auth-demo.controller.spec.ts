import type { IOAuthStore, TokenResponse } from '@nest-mcp/server';
import { AuthDemoController } from './auth-demo.controller';

describe('AuthDemoController', () => {
  let controller: AuthDemoController;
  let mockStore: IOAuthStore;
  let mockClientService: { registerClient: ReturnType<typeof vi.fn> };
  let mockJwtService: { generateTokenPair: ReturnType<typeof vi.fn> };

  const mockTokenResponse: TokenResponse = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    token_type: 'Bearer',
    expires_in: 86400,
  };

  beforeEach(() => {
    mockStore = {
      storeClient: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockResolvedValue(undefined),
      storeAuthCode: vi.fn().mockResolvedValue(undefined),
      getAuthCode: vi.fn().mockResolvedValue(undefined),
      removeAuthCode: vi.fn().mockResolvedValue(undefined),
      revokeToken: vi.fn().mockResolvedValue(undefined),
      isTokenRevoked: vi.fn().mockResolvedValue(false),
    };

    mockClientService = {
      registerClient: vi.fn().mockResolvedValue({
        client_id: 'test-client-id',
        client_name: 'demo-client',
        redirect_uris: ['http://localhost:8080/callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        created_at: 1000,
      }),
    };

    mockJwtService = {
      generateTokenPair: vi.fn().mockReturnValue(mockTokenResponse),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock injection for unit testing
    controller = new AuthDemoController(mockClientService as any, mockJwtService as any, mockStore);
  });

  describe('GET /auth/demo/flow', () => {
    it('should return all OAuth flow steps with tokens', async () => {
      const result = await controller.demonstrateOAuthFlow();

      expect(result.steps).toBeDefined();
      expect(result.steps['1_register_client'].client_id).toBe('test-client-id');
      expect(result.steps['2_pkce'].code_challenge_method).toBe('S256');
      expect(result.steps['2_pkce'].code_verifier).toBeDefined();
      expect(result.steps['2_pkce'].code_challenge).toBeDefined();
      expect(result.steps['3_authorization'].code).toBeDefined();
      expect(result.steps['3_authorization'].scope).toBe('tools:read');
      expect(result.steps['4_token_exchange'].access_token).toBe('mock-access-token');
      expect(result.steps['4_token_exchange'].refresh_token).toBe('mock-refresh-token');
      expect(result.steps['4_token_exchange'].token_type).toBe('Bearer');
      expect(result.usage.curl).toContain('Authorization: Bearer mock-access-token');

      expect(mockStore.storeAuthCode).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: 'test-client-id',
          user_id: 'demo-user',
          scope: 'tools:read',
          code_challenge_method: 'S256',
        }),
      );
    });
  });

  describe('GET /auth/demo/test-token', () => {
    it('should return a token with default scopes', () => {
      const result = controller.generateTestToken();

      expect(result.access_token).toBe('mock-access-token');
      expect(result.token_type).toBe('Bearer');
      expect(result.expires_in).toBe(86400);
      expect(result.scopes).toEqual(['tools:read']);
    });

    it('should return a token with custom scopes', () => {
      const result = controller.generateTestToken('admin:read analytics:read');

      expect(result.scopes).toEqual(['admin:read', 'analytics:read']);
      expect(result.access_token).toBe('mock-access-token');
    });
  });
});
