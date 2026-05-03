import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ELICITATION_MODULE_OPTIONS,
  type ResolvedElicitationOptions,
} from '../interfaces/elicitation-options.interface';

/**
 * Single Nest guard that runs every user-supplied guard from
 * `ElicitationModuleOptions.guards` in order. Lets the controller declare
 * `@UseGuards(ElicitationGuardComposite)` once, while the actual list of
 * guards stays runtime-configurable via `forRoot`.
 *
 * User guards are registered as providers in `McpElicitationModule.forRoot`,
 * so `ModuleRef.get` resolves them with full DI. Returns `true` when no
 * guards are configured (open by default — apply your own auth at the app
 * level if you need it locked down).
 */
@Injectable()
export class ElicitationGuardComposite implements CanActivate {
  constructor(
    @Inject(ELICITATION_MODULE_OPTIONS) private readonly opts: ResolvedElicitationOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const guards = this.opts.guards;
    if (!guards?.length) return true;

    for (const GuardClass of guards) {
      const guard = this.resolveGuard(GuardClass);
      const ok = await guard.canActivate(ctx);
      if (!ok) return false;
    }
    return true;
  }

  private resolveGuard(GuardClass: Type<CanActivate>): CanActivate {
    try {
      return this.moduleRef.get(GuardClass, { strict: false });
    } catch {
      // Fallback for guards the user didn't expose to DI — instantiate
      // directly. Mirrors `ExecutionPipelineService.resolveGuard`.
      return new (GuardClass as new () => CanActivate)();
    }
  }
}
