import 'reflect-metadata';
import type { McpGuardClass } from '@nest-mcp/common';
import { resolveGuard } from './resolve-guard.util';

describe('resolveGuard', () => {
  let moduleRef: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    moduleRef = { get: vi.fn() };
  });

  it('resolves the guard from DI when registered as a provider', () => {
    const diGuard = { canActivate: vi.fn().mockReturnValue(true) };
    moduleRef.get.mockReturnValue(diGuard);
    const GuardClass = class DiGuard {} as unknown as McpGuardClass;

    const guard = resolveGuard(
      moduleRef as unknown as Parameters<typeof resolveGuard>[0],
      GuardClass,
    );

    expect(moduleRef.get).toHaveBeenCalledWith(GuardClass, { strict: false });
    expect(guard).toBe(diGuard);
  });

  it('falls back to bare new when the guard is not in DI', () => {
    moduleRef.get.mockImplementation(() => {
      throw new Error('not found');
    });
    class SimpleGuard {
      canActivate() {
        return true;
      }
    }

    const guard = resolveGuard(
      moduleRef as unknown as Parameters<typeof resolveGuard>[0],
      SimpleGuard as unknown as McpGuardClass,
    );

    expect(guard).toBeInstanceOf(SimpleGuard);
  });
});
