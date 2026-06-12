import type { McpAuthInfo, McpGuardContext } from '@nest-mcp/common';
import { McpAuthenticatedGuard } from './authenticated.guard';

describe('McpAuthenticatedGuard', () => {
  const guard = new McpAuthenticatedGuard();

  function makeContext(overrides: Partial<McpGuardContext> = {}): McpGuardContext {
    return {
      sessionId: 's',
      metadata: {},
      ...overrides,
    };
  }

  function makeAuthInfo(): McpAuthInfo {
    return { token: 'tok', clientId: 'client-1', scopes: ['read'] };
  }

  it('returns true when authInfo is present', () => {
    expect(guard.canActivate(makeContext({ authInfo: makeAuthInfo() }))).toBe(true);
  });

  it('returns true when user is present', () => {
    expect(guard.canActivate(makeContext({ user: { id: 'user-1' } }))).toBe(true);
  });

  it('returns true when both authInfo and user are present', () => {
    expect(
      guard.canActivate(makeContext({ authInfo: makeAuthInfo(), user: { id: 'user-1' } })),
    ).toBe(true);
  });

  it('returns false when both authInfo and user are absent', () => {
    expect(guard.canActivate(makeContext())).toBe(false);
  });
});
