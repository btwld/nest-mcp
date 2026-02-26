import { describe, expect, it } from 'vitest';
import { McpAuthModule } from './auth.module';
import type { OAuthProviderAdapter, OAuthProviderUser } from './interfaces/oauth-provider.interface';

const TEST_SECRET = 'a'.repeat(32);

class FakeProvider implements OAuthProviderAdapter {
  readonly name = 'FakeProvider';

  async validateUser(_req: unknown): Promise<OAuthProviderUser | null> {
    return { id: 'user-123', email: 'test@example.com' };
  }
}

describe('McpAuthModule', () => {
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
      const optionsProvider = (result.providers as Array<{ provide: unknown; useValue: unknown }>)?.find(
        (p) => typeof p === 'object' && 'useValue' in p && typeof (p.useValue as Record<string, unknown>)?.validateUser === 'function',
      ) as { useValue: { validateUser: (req: unknown) => Promise<OAuthProviderUser | null> } } | undefined;

      expect(optionsProvider).toBeDefined();

      const user = await optionsProvider!.useValue.validateUser({ headers: {} });
      expect(validateSpy).toHaveBeenCalledWith({ headers: {} });
      expect(user).toEqual({ id: 'user-123', email: 'test@example.com' });
    });

    it('throws when jwtSecret is too short', () => {
      const adapter = new FakeProvider();
      expect(() =>
        McpAuthModule.forProvider(adapter, { jwtSecret: 'short' }),
      ).toThrow('jwtSecret must be at least 32 characters');
    });
  });
});
