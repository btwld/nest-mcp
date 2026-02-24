import {
  type CircuitBreakerConfig,
  CircuitBreakerState,
  MCP_CIRCUIT_OPEN,
  McpError,
} from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';

interface CircuitState {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  totalRequests: number;
  lastFailureTime: number;
  nextRetryTime: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitState>();

  async execute<T>(
    toolName: string,
    config: CircuitBreakerConfig,
    fn: () => Promise<T>,
  ): Promise<T> {
    const circuit = this.getOrCreateCircuit(toolName);
    const threshold = config.errorThreshold ?? 0.5;
    const timeWindow = config.timeWindow ?? 60_000;
    const minRequests = config.minRequests ?? 5;
    const halfOpenTimeout = config.halfOpenTimeout ?? 30_000;

    // Check circuit state
    if (circuit.state === CircuitBreakerState.OPEN) {
      if (Date.now() >= circuit.nextRetryTime) {
        circuit.state = CircuitBreakerState.HALF_OPEN;
        circuit.successes = 0;
        this.logger.log(`Circuit ${toolName}: OPEN → HALF_OPEN`);
      } else {
        throw new McpError(`Circuit breaker is OPEN for '${toolName}'`, MCP_CIRCUIT_OPEN);
      }
    }

    try {
      const result = await fn();
      this.onSuccess(toolName, circuit);
      return result;
    } catch (error) {
      this.onFailure(toolName, circuit, threshold, minRequests, halfOpenTimeout);
      throw error;
    }
  }

  private getOrCreateCircuit(toolName: string): CircuitState {
    let circuit = this.circuits.get(toolName);
    if (!circuit) {
      circuit = {
        state: CircuitBreakerState.CLOSED,
        failures: 0,
        successes: 0,
        totalRequests: 0,
        lastFailureTime: 0,
        nextRetryTime: 0,
      };
      this.circuits.set(toolName, circuit);
    }
    return circuit;
  }

  private onSuccess(toolName: string, circuit: CircuitState): void {
    circuit.successes++;
    circuit.totalRequests++;

    if (circuit.state === CircuitBreakerState.HALF_OPEN) {
      circuit.state = CircuitBreakerState.CLOSED;
      circuit.failures = 0;
      circuit.totalRequests = 0;
      this.logger.log(`Circuit ${toolName}: HALF_OPEN → CLOSED`);
    }
  }

  private onFailure(
    toolName: string,
    circuit: CircuitState,
    threshold: number,
    minRequests: number,
    halfOpenTimeout: number,
  ): void {
    circuit.failures++;
    circuit.totalRequests++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === CircuitBreakerState.HALF_OPEN) {
      circuit.state = CircuitBreakerState.OPEN;
      circuit.nextRetryTime = Date.now() + halfOpenTimeout;
      this.logger.warn(`Circuit ${toolName}: HALF_OPEN → OPEN`);
      return;
    }

    if (
      circuit.totalRequests >= minRequests &&
      circuit.failures / circuit.totalRequests >= threshold
    ) {
      circuit.state = CircuitBreakerState.OPEN;
      circuit.nextRetryTime = Date.now() + halfOpenTimeout;
      this.logger.warn(
        `Circuit ${toolName}: CLOSED → OPEN (${circuit.failures}/${circuit.totalRequests} failures)`,
      );
    }
  }

  getState(toolName: string): CircuitBreakerState | undefined {
    return this.circuits.get(toolName)?.state;
  }
}
