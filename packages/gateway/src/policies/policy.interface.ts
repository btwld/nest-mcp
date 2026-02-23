export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyRule {
  pattern: string;
  effect: PolicyEffect;
  reason?: string;
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
