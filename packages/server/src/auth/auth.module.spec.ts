import { describe, expect, it } from 'vitest';
import { McpAuthModule } from './auth.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type {
  OAuthProviderAdapter,
  OAuthProviderUser,
} from './interfaces/oauth-provider.interface';
import { MCP_OAUTH_STORE, OAuthClientService } from './services/client.service';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './services/jwt-token.service';
import { MemoryOAuthStore } from './stores/memory-store.service';

const TEST_SECRET = 'a'.repeat(32);

class FakeProvider implements OAuthProviderAdapter {
  readonly name = 'FakeProvider';

  async validateUser(_req: unknown): Promise<OAuthProviderUser | null> {
    return { id: 'user-123', email: 'test@example.com' };
  }
}

describe('McpAuthModule', () => {
  describe('forRoot', () => {
    it('returns McpAuthModule as the module class', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.module).toBe(McpAuthModule);
    });

    it('throws when jwtSecret is absent', () => {
      expect(() =>
        McpAuthModule.forRoot({ jwtSecret: '', validateUser: async () => null }),
      ).toThrow('jwtSecret must be at least 32 characters');
    });

    it('throws when jwtSecret is shorter than 32 characters', () => {
      expect(() =>
        McpAuthModule.forRoot({ jwtSecret: 'short', validateUser: async () => null }),
      ).toThrow('jwtSecret must be at least 32 characters');
    });

    it('has two controllers (OAuthController + WellKnownController)', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.controllers).toHaveLength(2);
    });

    it('includes JwtTokenService in providers', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.providers).toContain(JwtTokenService);
    });

    it('includes OAuthClientService in providers', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.providers).toContain(OAuthClientService);
    });

    it('exports JwtTokenService', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.exports).toContain(JwtTokenService);
    });

    it('exports MCP_AUTH_OPTIONS', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.exports).toContain(MCP_AUTH_OPTIONS);
    });

    it('exports MCP_OAUTH_STORE', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.exports).toContain(MCP_OAUTH_STORE);
    });

    it('uses MemoryOAuthStore by default', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      const storeProvider = (result.providers as { provide: unknown; useValue: unknown }[]).find(
        (p) => p.provide === MCP_OAUTH_STORE,
      );
      expect(storeProvider?.useValue).toBeInstanceOf(MemoryOAuthStore);
    });

    it('uses provided custom store instead of MemoryOAuthStore', () => {
      const customStore = { get: () => undefined, set: () => {}, delete: () => {} } as never;
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        store: customStore,
        validateUser: async () => null,
      });
      const storeProvider = (result.providers as { provide: unknown; useValue: unknown }[]).find(
        (p) => p.provide === MCP_OAUTH_STORE,
      );
      expect(storeProvider?.useValue).toBe(customStore);
    });
  });

  describe('forProvider', () => {
    it('creates a valid DynamicModule with the adapter wired in', () => {
      const adapter = new FakeProvider();
      const result = McpAuthModule.forProvider(adapter, {
        jwtSecret: TEST_SECRET,
        issuer: 'test',
      });

      expect(result).toBeDefined();
      expect(result.module).toBe(McpAuthModule);
      expect(result.providers).toBeDefined();
      expect(result.controllers).toBeDefined();
      expect(result.exports).toBeDefined();
    });

    it('delegates validateUser to the adapter', async () => {
      const adapter = new FakeProvider();
      const validateSpy = vi.spyOn(adapter, 'validateUser');

      const result = McpAuthModule.forProvider(adapter, {
        jwtSecret: TEST_SECRET,
      });

      // Extract the options provider to verify validateUser is wired
      const optionsProvider = (
        result.providers as Array<{ provide: unknown; useValue: unknown }>
      )?.find(
        (p) =>
          typeof p === 'object' &&
          'useValue' in p &&
          typeof (p.useValue as Record<string, unknown>)?.validateUser === 'function',
      ) as
        | { useValue: { validateUser: (req: unknown) => Promise<OAuthProviderUser | null> } }
        | undefined;

      expect(optionsProvider).toBeDefined();

      const user = await optionsProvider?.useValue.validateUser({ headers: {} });
      expect(validateSpy).toHaveBeenCalledWith({ headers: {} });
      expect(user).toEqual({ id: 'user-123', email: 'test@example.com' });
    });

    it('throws when jwtSecret is too short', () => {
      const adapter = new FakeProvider();
      expect(() => McpAuthModule.forProvider(adapter, { jwtSecret: 'short' })).toThrow(
        'jwtSecret must be at least 32 characters',
      );
    });
  });
});
