import { describe, expect, it } from 'vitest';
import { McpAuthModule } from './auth.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type {
  OAuthProviderAdapter,
  OAuthProviderUser,
} from './interfaces/oauth-provider.interface';
import {
  JwtBearerTokenVerifier,
  MCP_BEARER_TOKEN_VERIFIER,
} from './services/bearer-verifier.service';
import { MCP_OAUTH_STORE, OAuthClientService } from './services/client.service';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './services/jwt-token.service';
import { MemoryOAuthStore } from './stores/memory-store.service';

const TEST_SECRET = 'a'.repeat(32);

type FactoryProvider = {
  provide: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: test helper mirrors Nest's loose factory typing
  useFactory: (...args: any[]) => any;
  inject?: unknown[];
};

function findFactoryProvider(providers: unknown, token: unknown): FactoryProvider | undefined {
  return (providers as FactoryProvider[]).find(
    (p) => typeof p === 'object' && p !== null && p.provide === token,
  );
}

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

    it('provides JwtBearerTokenVerifier under MCP_BEARER_TOKEN_VERIFIER (overridable)', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      const verifierProvider = (result.providers as { provide: unknown; useClass: unknown }[]).find(
        (p) => p.provide === MCP_BEARER_TOKEN_VERIFIER,
      );
      expect(verifierProvider?.useClass).toBe(JwtBearerTokenVerifier);
    });

    it('exports MCP_BEARER_TOKEN_VERIFIER', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.exports).toContain(MCP_BEARER_TOKEN_VERIFIER);
    });

    it('exports MCP_OAUTH_STORE', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      expect(result.exports).toContain(MCP_OAUTH_STORE);
    });

    it('provides MCP_OAUTH_STORE via a factory injecting MCP_AUTH_OPTIONS', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      const storeProvider = findFactoryProvider(result.providers, MCP_OAUTH_STORE);
      expect(storeProvider?.inject).toEqual([MCP_AUTH_OPTIONS]);
    });

    it('store factory creates MemoryOAuthStore by default', () => {
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        validateUser: async () => null,
      });
      const storeProvider = findFactoryProvider(result.providers, MCP_OAUTH_STORE);
      expect(storeProvider?.useFactory({ jwtSecret: TEST_SECRET })).toBeInstanceOf(
        MemoryOAuthStore,
      );
    });

    it('store factory returns the store from options when provided', () => {
      const customStore = { isTokenRevoked: async () => false } as never;
      const result = McpAuthModule.forRoot({
        jwtSecret: TEST_SECRET,
        store: customStore,
        validateUser: async () => null,
      });
      const storeProvider = findFactoryProvider(result.providers, MCP_OAUTH_STORE);
      expect(storeProvider?.useFactory({ jwtSecret: TEST_SECRET, store: customStore })).toBe(
        customStore,
      );
    });
  });

  describe('forRootAsync', () => {
    it('returns McpAuthModule with controllers and pass-through imports', () => {
      class FakeConfigModule {}
      const result = McpAuthModule.forRootAsync({
        imports: [FakeConfigModule],
        serverUrl: 'https://auth.example.com',
        useFactory: () => ({ jwtSecret: TEST_SECRET }),
      });

      expect(result.module).toBe(McpAuthModule);
      expect(result.imports).toEqual([FakeConfigModule]);
      expect(result.controllers).toHaveLength(2);
    });

    it('provides MCP_AUTH_OPTIONS via the given factory and inject tokens', async () => {
      const useFactory = vi.fn().mockResolvedValue({ jwtSecret: TEST_SECRET });
      const result = McpAuthModule.forRootAsync({ useFactory, inject: ['CONFIG'] });

      const optionsProvider = findFactoryProvider(result.providers, MCP_AUTH_OPTIONS);
      expect(optionsProvider?.inject).toEqual(['CONFIG']);

      const resolved = await optionsProvider?.useFactory({ some: 'dep' });
      expect(useFactory).toHaveBeenCalledWith({ some: 'dep' });
      expect(resolved).toEqual({ jwtSecret: TEST_SECRET });
    });

    it('validates jwtSecret length when the factory resolves', async () => {
      const result = McpAuthModule.forRootAsync({
        useFactory: () => ({ jwtSecret: 'short' }),
      });

      const optionsProvider = findFactoryProvider(result.providers, MCP_AUTH_OPTIONS);
      await expect(optionsProvider?.useFactory()).rejects.toThrow(
        'jwtSecret must be at least 32 characters',
      );
    });

    it('store factory lets a factory-provided store win over the default', () => {
      const customStore = { isTokenRevoked: async () => false } as never;
      const result = McpAuthModule.forRootAsync({
        useFactory: () => ({ jwtSecret: TEST_SECRET, store: customStore }),
      });

      const storeProvider = findFactoryProvider(result.providers, MCP_OAUTH_STORE);
      expect(storeProvider?.inject).toEqual([MCP_AUTH_OPTIONS]);
      expect(storeProvider?.useFactory({ jwtSecret: TEST_SECRET, store: customStore })).toBe(
        customStore,
      );
      expect(storeProvider?.useFactory({ jwtSecret: TEST_SECRET })).toBeInstanceOf(
        MemoryOAuthStore,
      );
    });

    it('exports the same tokens as forRoot', () => {
      const result = McpAuthModule.forRootAsync({
        useFactory: () => ({ jwtSecret: TEST_SECRET }),
      });

      expect(result.exports).toContain(JwtTokenService);
      expect(result.exports).toContain(MCP_AUTH_OPTIONS);
      expect(result.exports).toContain(MCP_OAUTH_STORE);
      expect(result.exports).toContain(MCP_BEARER_TOKEN_VERIFIER);
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
