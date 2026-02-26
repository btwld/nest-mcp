import { Injectable, Logger } from '@nestjs/common';
import { matchGlobPattern } from '../utils/pattern-matcher';
import type {
  PoliciesConfig,
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

  evaluate(toolName: string): PolicyEvaluationResult {
    for (const rule of this.rules) {
      if (matchGlobPattern(toolName, rule.pattern)) {
        return {
          effect: rule.effect,
          matchedRule: rule,
          reason: rule.reason,
        };
      }
    }

    return { effect: this.defaultEffect };
  }
}
