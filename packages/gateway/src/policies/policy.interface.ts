export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyRule {
  pattern: string;
  effect: PolicyEffect;
  reason?: string;
  roles?: string[];
  scopes?: string[];
  userMatch?: string;
}

export interface PolicyContext {
  userId?: string;
  roles?: string[];
  scopes?: string[];
}

export interface PoliciesConfig {
  defaultEffect: PolicyEffect;
  rules: PolicyRule[];
}

export interface PolicyEvaluationResult {
  effect: PolicyEffect;
  matchedRule?: PolicyRule;
  reason?: string;
}
