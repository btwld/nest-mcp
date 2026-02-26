import { PolicyEngineService } from './policy-engine.service';

describe('PolicyEngineService', () => {
  let service: PolicyEngineService;

  beforeEach(() => {
    service = new PolicyEngineService();
  });

  describe('configure', () => {
    it('should set default effect and rules', () => {
      service.configure({
        defaultEffect: 'deny',
        rules: [{ pattern: 'safe_*', effect: 'allow' }],
      });

      // A non-matching tool should use the default effect
      const result = service.evaluate('unknown_tool');
      expect(result.effect).toBe('deny');
    });
  });

  describe('evaluate', () => {
    it('should return default effect when no rules match', () => {
      service.configure({ defaultEffect: 'allow', rules: [] });

      const result = service.evaluate('any_tool');

      expect(result.effect).toBe('allow');
      expect(result.matchedRule).toBeUndefined();
    });

    it('should match wildcard * pattern', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: '*', effect: 'deny', reason: 'blocked all' }],
      });

      const result = service.evaluate('any_tool');

      expect(result.effect).toBe('deny');
      expect(result.reason).toBe('blocked all');
    });

    it('should match prefix_* wildcard pattern', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'admin_*', effect: 'deny', reason: 'admin blocked' }],
      });

      expect(service.evaluate('admin_delete').effect).toBe('deny');
      expect(service.evaluate('user_delete').effect).toBe('allow');
    });

    it('should match exact tool name', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'dangerous_tool', effect: 'deny' }],
      });

      expect(service.evaluate('dangerous_tool').effect).toBe('deny');
      expect(service.evaluate('dangerous_tool_extra').effect).toBe('allow');
    });

    it('should return first matching rule (first match wins)', () => {
      service.configure({
        defaultEffect: 'deny',
        rules: [
          { pattern: 'gh_*', effect: 'allow', reason: 'first' },
          { pattern: 'gh_*', effect: 'deny', reason: 'second' },
        ],
      });

      const result = service.evaluate('gh_listRepos');

      expect(result.effect).toBe('allow');
      expect(result.reason).toBe('first');
    });

    it('should support allow effect', () => {
      service.configure({
        defaultEffect: 'deny',
        rules: [{ pattern: 'safe_*', effect: 'allow' }],
      });

      expect(service.evaluate('safe_read').effect).toBe('allow');
    });

    it('should support require_approval effect', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'risky_*', effect: 'require_approval', reason: 'needs approval' }],
      });

      const result = service.evaluate('risky_deploy');

      expect(result.effect).toBe('require_approval');
      expect(result.matchedRule).toEqual({
        pattern: 'risky_*',
        effect: 'require_approval',
        reason: 'needs approval',
      });
    });

    it('should include matched rule in result', () => {
      const rule = { pattern: 'test_*', effect: 'deny' as const, reason: 'testing' };
      service.configure({ defaultEffect: 'allow', rules: [rule] });

      const result = service.evaluate('test_something');

      expect(result.matchedRule).toEqual(rule);
    });
  });

  describe('evaluate with PolicyContext', () => {
    it('should match rule with roles when user has matching role', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'admin_*', effect: 'deny', roles: ['admin'] }],
      });

      const result = service.evaluate('admin_delete', { roles: ['admin', 'user'] });

      expect(result.effect).toBe('deny');
    });

    it('should skip rule with roles when user lacks required role', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'admin_*', effect: 'deny', roles: ['admin'] }],
      });

      const result = service.evaluate('admin_delete', { roles: ['user'] });

      expect(result.effect).toBe('allow');
    });

    it('should skip rule with roles when no context provided', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'admin_*', effect: 'deny', roles: ['admin'] }],
      });

      const result = service.evaluate('admin_delete');

      expect(result.effect).toBe('allow');
    });

    it('should skip rule with roles when context has empty roles', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'admin_*', effect: 'deny', roles: ['admin'] }],
      });

      const result = service.evaluate('admin_delete', { roles: [] });

      expect(result.effect).toBe('allow');
    });

    it('should match rule with scopes on overlap', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'write_*', effect: 'deny', scopes: ['write', 'delete'] }],
      });

      const result = service.evaluate('write_file', { scopes: ['read', 'write'] });

      expect(result.effect).toBe('deny');
    });

    it('should skip rule with scopes when no overlap', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'write_*', effect: 'deny', scopes: ['write'] }],
      });

      const result = service.evaluate('write_file', { scopes: ['read'] });

      expect(result.effect).toBe('allow');
    });

    it('should match rule with userMatch glob pattern', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'deploy_*', effect: 'deny', userMatch: 'bot-*' }],
      });

      const result = service.evaluate('deploy_prod', { userId: 'bot-ci' });

      expect(result.effect).toBe('deny');
    });

    it('should skip rule with userMatch when userId does not match', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'deploy_*', effect: 'deny', userMatch: 'bot-*' }],
      });

      const result = service.evaluate('deploy_prod', { userId: 'human-alice' });

      expect(result.effect).toBe('allow');
    });

    it('should skip rule with userMatch when no userId provided', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [{ pattern: 'deploy_*', effect: 'deny', userMatch: 'bot-*' }],
      });

      const result = service.evaluate('deploy_prod', {});

      expect(result.effect).toBe('allow');
    });

    it('should require all context fields to match when multiple are set', () => {
      service.configure({
        defaultEffect: 'allow',
        rules: [
          {
            pattern: 'admin_*',
            effect: 'deny',
            roles: ['admin'],
            scopes: ['dangerous'],
            userMatch: 'bot-*',
          },
        ],
      });

      // All match
      expect(
        service.evaluate('admin_nuke', {
          roles: ['admin'],
          scopes: ['dangerous'],
          userId: 'bot-ci',
        }).effect,
      ).toBe('deny');

      // roles match, scopes don't
      expect(
        service.evaluate('admin_nuke', {
          roles: ['admin'],
          scopes: ['safe'],
          userId: 'bot-ci',
        }).effect,
      ).toBe('allow');

      // roles don't match
      expect(
        service.evaluate('admin_nuke', {
          roles: ['user'],
          scopes: ['dangerous'],
          userId: 'bot-ci',
        }).effect,
      ).toBe('allow');

      // userMatch doesn't match
      expect(
        service.evaluate('admin_nuke', {
          roles: ['admin'],
          scopes: ['dangerous'],
          userId: 'human-alice',
        }).effect,
      ).toBe('allow');
    });

    it('should maintain backward compatibility — no context arg works as before', () => {
      service.configure({
        defaultEffect: 'deny',
        rules: [{ pattern: 'gh_*', effect: 'allow' }],
      });

      expect(service.evaluate('gh_list').effect).toBe('allow');
      expect(service.evaluate('other').effect).toBe('deny');
    });

    it('should fall through to next rule when context does not match', () => {
      service.configure({
        defaultEffect: 'deny',
        rules: [
          { pattern: 'gh_*', effect: 'deny', roles: ['blocked'] },
          { pattern: 'gh_*', effect: 'allow' },
        ],
      });

      // First rule skipped (no matching role), second rule matches
      const result = service.evaluate('gh_list', { roles: ['user'] });
      expect(result.effect).toBe('allow');
    });
  });
});
