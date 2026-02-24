import 'reflect-metadata';
import {
  MCP_GUARDS_METADATA,
  MCP_PUBLIC_METADATA,
  MCP_ROLES_METADATA,
  MCP_SCOPES_METADATA,
} from '@btwld/mcp-common';
import { Guards } from './guards.decorator';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { Scopes } from './scopes.decorator';

describe('Auth decorators', () => {
  describe('@Public', () => {
    it('sets MCP_PUBLIC_METADATA to true', () => {
      class TestService {
        @Public()
        openMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(MCP_PUBLIC_METADATA, TestService.prototype, 'openMethod');

      expect(value).toBe(true);
    });
  });

  describe('@Scopes', () => {
    it('stores string array of scopes', () => {
      class TestService {
        @Scopes(['read', 'write', 'admin'])
        scopedMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(MCP_SCOPES_METADATA, TestService.prototype, 'scopedMethod');

      expect(value).toEqual(['read', 'write', 'admin']);
    });
  });

  describe('@Roles', () => {
    it('stores string array of roles', () => {
      class TestService {
        @Roles(['admin', 'editor'])
        protectedMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(
        MCP_ROLES_METADATA,
        TestService.prototype,
        'protectedMethod',
      );

      expect(value).toEqual(['admin', 'editor']);
    });
  });

  describe('@Guards', () => {
    it('stores Function array of guards', () => {
      function AuthGuard() {
        return true;
      }
      function RateLimitGuard() {
        return true;
      }

      class TestService {
        @Guards([AuthGuard, RateLimitGuard])
        guardedMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(
        MCP_GUARDS_METADATA,
        TestService.prototype,
        'guardedMethod',
      );

      expect(value).toEqual([AuthGuard, RateLimitGuard]);
      expect(value).toHaveLength(2);
      expect(value[0]).toBe(AuthGuard);
      expect(value[1]).toBe(RateLimitGuard);
    });
  });
});
