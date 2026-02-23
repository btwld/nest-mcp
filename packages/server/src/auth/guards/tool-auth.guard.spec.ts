import 'reflect-metadata';
import { ToolAuthGuardService } from './tool-auth.guard';
import { AuthorizationError } from '@btwld/mcp-common';
import type { McpGuardContext } from '@btwld/mcp-common';
import type { RegisteredTool } from '../../discovery/registry.service';

describe('ToolAuthGuardService', () => {
  let guard: ToolAuthGuardService;

  beforeEach(() => {
    guard = new ToolAuthGuardService();
  });

  function makeContext(overrides: Partial<McpGuardContext> = {}): McpGuardContext {
    return {
      sessionId: 'test-session',
      metadata: {},
      ...overrides,
    };
  }

  function makeTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
    return {
      name: 'test-tool',
      description: 'A test tool',
      methodName: 'handle',
      target: Object,
      instance: {},
      isPublic: false,
      ...overrides,
    } as RegisteredTool;
  }

  // --- Public tools ---

  it('passes for isPublic tools', async () => {
    const tool = makeTool({ isPublic: true });
    await expect(guard.checkAuthorization(tool, makeContext())).resolves.toBeUndefined();
  });

  // --- No scopes/roles/guards ---

  it('passes when no scopes, roles, or guards are required', async () => {
    const tool = makeTool({ isPublic: false });
    await expect(guard.checkAuthorization(tool, makeContext())).resolves.toBeUndefined();
  });

  // --- Scopes ---

  describe('scopes', () => {
    it('passes when user has all required scopes', async () => {
      const tool = makeTool({ requiredScopes: ['read', 'write'] });
      const context = makeContext({ user: { scopes: ['read', 'write', 'admin'] } });

      await expect(guard.checkAuthorization(tool, context)).resolves.toBeUndefined();
    });

    it('throws AuthorizationError when user lacks any required scope', async () => {
      const tool = makeTool({ requiredScopes: ['read', 'write'] });
      const context = makeContext({ user: { scopes: ['read'] } });

      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow(AuthorizationError);
      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow('requires scopes');
    });

    it('throws when user has no scopes at all', async () => {
      const tool = makeTool({ requiredScopes: ['read'] });
      const context = makeContext({ user: {} });

      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow(AuthorizationError);
    });

    it('throws when user is undefined', async () => {
      const tool = makeTool({ requiredScopes: ['read'] });
      const context = makeContext();

      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow(AuthorizationError);
    });
  });

  // --- Roles ---

  describe('roles', () => {
    it('passes when user has at least one required role', async () => {
      const tool = makeTool({ requiredRoles: ['admin', 'superadmin'] });
      const context = makeContext({ user: { roles: ['admin'] } });

      await expect(guard.checkAuthorization(tool, context)).resolves.toBeUndefined();
    });

    it('throws AuthorizationError when user has none of the required roles', async () => {
      const tool = makeTool({ requiredRoles: ['admin', 'superadmin'] });
      const context = makeContext({ user: { roles: ['viewer'] } });

      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow(AuthorizationError);
      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow('requires one of roles');
    });

    it('throws when user has no roles', async () => {
      const tool = makeTool({ requiredRoles: ['admin'] });
      const context = makeContext({ user: {} });

      await expect(guard.checkAuthorization(tool, context)).rejects.toThrow(AuthorizationError);
    });
  });

  // --- Custom guards ---

  describe('custom guards', () => {
    it('executes custom guards that return true', async () => {
      const canActivate = vi.fn().mockResolvedValue(true);
      class AllowGuard {
        canActivate = canActivate;
      }

      const tool = makeTool({ guards: [AllowGuard as any] });
      await expect(guard.checkAuthorization(tool, makeContext())).resolves.toBeUndefined();
      expect(canActivate).toHaveBeenCalled();
    });

    it('throws AuthorizationError when custom guard returns false', async () => {
      class DenyGuard {
        canActivate() {
          return false;
        }
      }

      const tool = makeTool({ guards: [DenyGuard as any] });
      await expect(guard.checkAuthorization(tool, makeContext())).rejects.toThrow(AuthorizationError);
      await expect(guard.checkAuthorization(tool, makeContext())).rejects.toThrow('authorization denied by guard');
    });

    it('handles async guards', async () => {
      class AsyncGuard {
        async canActivate() {
          return true;
        }
      }

      const tool = makeTool({ guards: [AsyncGuard as any] });
      await expect(guard.checkAuthorization(tool, makeContext())).resolves.toBeUndefined();
    });

    it('stops at first guard rejection', async () => {
      const secondGuard = vi.fn();
      class DenyGuard {
        canActivate() {
          return false;
        }
      }
      class SecondGuard {
        canActivate = secondGuard;
      }

      const tool = makeTool({ guards: [DenyGuard as any, SecondGuard as any] });
      await expect(guard.checkAuthorization(tool, makeContext())).rejects.toThrow(AuthorizationError);
      expect(secondGuard).not.toHaveBeenCalled();
    });

    it('passes guard context to canActivate', async () => {
      const canActivate = vi.fn().mockReturnValue(true);
      class InspectGuard {
        canActivate = canActivate;
      }

      const context = makeContext({ user: { id: 'user-1' }, toolName: 'test-tool' });
      const tool = makeTool({ guards: [InspectGuard as any] });

      await guard.checkAuthorization(tool, context);

      expect(canActivate).toHaveBeenCalledWith(context);
    });
  });
});
