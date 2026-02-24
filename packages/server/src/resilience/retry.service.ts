import type { RetryConfig } from '@btwld/mcp-common';
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

  private calculateDelay(
    attempt: number,
    backoff: RetryConfig['backoff'],
    initialDelay: number,
    maxDelay: number,
  ): number {
    let delay: number;

    switch (backoff) {
      case 'exponential':
        delay = initialDelay * 2 ** (attempt - 1);
        // Add jitter (±25%)
        delay = delay * (0.75 + Math.random() * 0.5);
        break;
      case 'linear':
        delay = initialDelay * attempt;
        break;
      default:
        delay = initialDelay;
        break;
    }

    return Math.min(delay, maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
