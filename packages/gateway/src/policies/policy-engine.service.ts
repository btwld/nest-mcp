import { Injectable, Logger } from '@nestjs/common';
import { matchGlobPattern } from '../utils/pattern-matcher';
import type {
  PoliciesConfig,
  PolicyContext,
  PolicyEffect,
  PolicyEvaluationResult,
  PolicyRule,
} from './policy.interface';

@Injectable()
export class PolicyEngineService {
  private readonly logger = new Logger(PolicyEngineService.name);
  private defaultEffect: PolicyEffect = 'allow';
  private rules: PolicyRule[] = [];

  configure(config: PoliciesConfig): void {
    this.defaultEffect = config.defaultEffect;
    this.rules = config.rules ?? [];
    this.logger.log(
      `Policy engine configured: default=${this.defaultEffect}, ${this.rules.length} rules`,
    );
  }

  evaluate(toolName: string, context?: PolicyContext): PolicyEvaluationResult {
    for (const rule of this.rules) {
      if (!matchGlobPattern(toolName, rule.pattern)) continue;
      if (!this.matchesContext(rule, context)) continue;

      return {
        effect: rule.effect,
        matchedRule: rule,
        reason: rule.reason,
      };
    }

    return { effect: this.defaultEffect };
  }

  private matchesContext(rule: PolicyRule, context?: PolicyContext): boolean {
    if (rule.roles?.length) {
      if (!context?.roles?.length) return false;
      if (!rule.roles.some((r) => context.roles?.includes(r))) return false;
    }

    if (rule.scopes?.length) {
      if (!context?.scopes?.length) return false;
      if (!rule.scopes.some((s) => context.scopes?.includes(s))) return false;
    }

    if (rule.userMatch) {
      if (!context?.userId) return false;
      if (!matchGlobPattern(context.userId, rule.userMatch)) return false;
    }

    return true;
  }
}
