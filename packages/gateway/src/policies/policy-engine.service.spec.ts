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
});
