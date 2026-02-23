import 'reflect-metadata';
import { CircuitBreakerService } from './circuit-breaker.service';
import { McpError, MCP_CIRCUIT_OPEN, CircuitBreakerState } from '@btwld/mcp-common';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  const defaultConfig = {
    errorThreshold: 0.5,
    minRequests: 5,
    halfOpenTimeout: 30_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    service = new CircuitBreakerService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes fn and returns result when CLOSED', async () => {
    const result = await service.execute('tool-a', defaultConfig, async () => 'ok');
    expect(result).toBe('ok');
    expect(service.getState('tool-a')).toBe(CircuitBreakerState.CLOSED);
  });

  it('remains CLOSED when failures below threshold', async () => {
    // 2 successes, 2 failures = 4 requests total (below minRequests=5)
    await service.execute('tool-a', defaultConfig, async () => 'ok');
    await service.execute('tool-a', defaultConfig, async () => 'ok');
    await expect(
      service.execute('tool-a', defaultConfig, async () => { throw new Error('fail'); }),
    ).rejects.toThrow('fail');
    await expect(
      service.execute('tool-a', defaultConfig, async () => { throw new Error('fail'); }),
    ).rejects.toThrow('fail');

    expect(service.getState('tool-a')).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions CLOSED -> OPEN when errorThreshold exceeded with minRequests met', async () => {
    // Need minRequests=5, with >= 50% failures
    // 5 failures out of 5 requests
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', defaultConfig, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }

    expect(service.getState('tool-a')).toBe(CircuitBreakerState.OPEN);
  });

  it('throws McpError with MCP_CIRCUIT_OPEN when OPEN', async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', defaultConfig, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }

    try {
      await service.execute('tool-a', defaultConfig, async () => 'ok');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(MCP_CIRCUIT_OPEN);
      expect((err as McpError).message).toContain("Circuit breaker is OPEN for 'tool-a'");
    }
  });

  it('transitions OPEN -> HALF_OPEN after halfOpenTimeout', async () => {
    const config = { ...defaultConfig, halfOpenTimeout: 10_000 };

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', config, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }
    expect(service.getState('tool-a')).toBe(CircuitBreakerState.OPEN);

    // Advance past halfOpenTimeout
    vi.advanceTimersByTime(10_000);

    // Next call should transition to HALF_OPEN and execute
    const result = await service.execute('tool-a', config, async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('transitions HALF_OPEN -> CLOSED on success', async () => {
    const config = { ...defaultConfig, halfOpenTimeout: 10_000 };

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', config, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }

    // Advance to half-open
    vi.advanceTimersByTime(10_000);

    // Success in HALF_OPEN transitions to CLOSED
    await service.execute('tool-a', config, async () => 'ok');
    expect(service.getState('tool-a')).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions HALF_OPEN -> OPEN on failure', async () => {
    const config = { ...defaultConfig, halfOpenTimeout: 10_000 };

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', config, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }

    // Advance to half-open
    vi.advanceTimersByTime(10_000);

    // Failure in HALF_OPEN goes back to OPEN
    await expect(
      service.execute('tool-a', config, async () => { throw new Error('still failing'); }),
    ).rejects.toThrow('still failing');
    expect(service.getState('tool-a')).toBe(CircuitBreakerState.OPEN);
  });

  it('does not open before minRequests reached', async () => {
    const config = { errorThreshold: 0.5, minRequests: 10, halfOpenTimeout: 30_000 };

    // 5 failures out of 5 requests, but minRequests is 10
    for (let i = 0; i < 5; i++) {
      await expect(
        service.execute('tool-a', config, async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');
    }

    expect(service.getState('tool-a')).toBe(CircuitBreakerState.CLOSED);
  });

  it('getState returns undefined for unknown tool', () => {
    expect(service.getState('non-existent')).toBeUndefined();
  });
});
