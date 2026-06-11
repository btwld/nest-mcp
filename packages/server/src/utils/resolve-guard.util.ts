import type { McpGuard, McpGuardClass } from '@nest-mcp/common';
import type { ModuleRef } from '@nestjs/core';

/**
 * Resolves a guard class through Nest DI when it is registered as a provider
 * (so constructor-injected dependencies work), falling back to a bare `new`
 * for simple guards that are not part of any module.
 */
export function resolveGuard(moduleRef: ModuleRef, GuardClass: McpGuardClass): McpGuard {
  try {
    return moduleRef.get(GuardClass, { strict: false });
  } catch {
    // Guard not in DI — instantiate directly (for simple guards)
    return new (GuardClass as new () => McpGuard)();
  }
}
