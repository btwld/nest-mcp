export interface RateLimitConfig {
  max: number;
  window: string;
  perUser?: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  backoff: 'exponential' | 'linear' | 'fixed';
  initialDelay?: number;
  maxDelay?: number;
}

export interface CircuitBreakerConfig {
  errorThreshold?: number;
  timeWindow?: number;
  minRequests?: number;
  halfOpenTimeout?: number;
}

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}
