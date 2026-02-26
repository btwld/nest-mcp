import type { RetryConfig } from '@btwld/mcp-common';
import { McpError } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RetryService {
  private readonly logger = new Logger(RetryService.name);

  async execute<T>(toolName: string, config: RetryConfig, fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, backoff, initialDelay = 100, maxDelay = 10_000 } = config;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Non-retriable MCP errors should not be retried
        if (error instanceof McpError && !error.isRetriable) {
          throw error;
        }

        if (attempt < maxAttempts) {
          const delay = this.calculateDelay(attempt, backoff, initialDelay, maxDelay);
          this.logger.warn(
            `Tool '${toolName}' attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`,
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private static readonly DELAY_STRATEGIES: Record<string, (attempt: number, initialDelay: number, maxDelay: number) => number> = {
    exponential: (a, i, m) => Math.random() * Math.min(m, i * 2 ** (a - 1)),
    linear: (a, i) => i * a,
  };

  private calculateDelay(
    attempt: number,
    backoff: RetryConfig['backoff'],
    initialDelay: number,
    maxDelay: number,
  ): number {
    const strategy = RetryService.DELAY_STRATEGIES[backoff ?? 'fixed'];
    const delay = strategy ? strategy(attempt, initialDelay, maxDelay) : initialDelay;
    return Math.min(delay, maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
