import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { UpstreamManagerService } from './upstream-manager.service';
import type { UpstreamConfig } from './upstream.interface';

@Injectable()
export class HealthCheckerService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthCheckerService.name);
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly upstreamManager: UpstreamManagerService) {}

  startAll(configs: UpstreamConfig[]): void {
    for (const config of configs) {
      if (config.healthCheck?.enabled !== false && config.enabled !== false) {
        this.start(config);
      }
    }
  }

  start(config: UpstreamConfig): void {
    const intervalMs = config.healthCheck?.intervalMs ?? 30000;
    const name = config.name;

    if (this.intervals.has(name)) {
      return;
    }

    this.logger.log(`Starting health checks for "${name}" every ${intervalMs}ms`);

    const interval = setInterval(async () => {
      await this.check(name, config.healthCheck?.timeoutMs ?? 5000);
    }, intervalMs);

    this.intervals.set(name, interval);
  }

  async check(name: string, timeoutMs = 5000): Promise<boolean> {
    const client = this.upstreamManager.getClient(name);
    if (!client) {
      this.upstreamManager.setHealthy(name, false, 'Client not found');
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      await client.ping({ signal: controller.signal });
      clearTimeout(timeout);

      this.upstreamManager.setHealthy(name, true);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Health check failed for "${name}": ${message}`);
      this.upstreamManager.setHealthy(name, false, message);
      return false;
    }
  }

  stop(name: string): void {
    const interval = this.intervals.get(name);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(name);
    }
  }

  stopAll(): void {
    for (const name of this.intervals.keys()) {
      this.stop(name);
    }
  }

  onModuleDestroy(): void {
    this.stopAll();
  }
}
