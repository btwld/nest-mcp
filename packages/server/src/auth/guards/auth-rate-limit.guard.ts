import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { parseDurationMs } from '@btwld/mcp-common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { AuthAuditService } from '../services/auth-audit.service';
import { MCP_AUTH_OPTIONS } from '../services/jwt-token.service';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(MCP_AUTH_OPTIONS) private readonly options: McpAuthModuleOptions,
    @Optional() @Inject('AuthAuditService') private readonly auditService?: AuthAuditService,
  ) {
    const config = this.options.authRateLimit;
    this.max = config?.max ?? 20;
    this.windowMs = parseDurationMs(config?.window ?? '1m', 60_000);
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ip = this.extractIp(request);
    const now = Date.now();

    const bucket = this.getOrCreateBucket(ip, now);

    bucket.count++;

    if (bucket.count > this.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);

      if (this.auditService) {
        this.auditService.logRateLimited(ip);
      }

      throw new HttpException(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many requests',
          retry_after: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private extractIp(request: { ip?: string; socket?: { remoteAddress?: string } }): string {
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }

  private getOrCreateBucket(ip: string, now: number): RateLimitBucket {
    const existing = this.buckets.get(ip);
    if (existing && now < existing.resetAt) {
      return existing;
    }
    const bucket: RateLimitBucket = { count: 0, resetAt: now + this.windowMs };
    this.buckets.set(ip, bucket);
    return bucket;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(ip);
      }
    }
  }
}
