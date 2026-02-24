import 'reflect-metadata';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('recordCall creates entry and increments totalCalls', () => {
    service.recordCall('tool-a', 100, true);
    const metric = service.getToolMetrics('tool-a');
    expect(metric).toBeDefined();
    expect(metric?.totalCalls).toBe(1);
    expect(metric?.name).toBe('tool-a');
  });

  it('increments successCount on success', () => {
    service.recordCall('tool-a', 100, true);
    service.recordCall('tool-a', 200, true);
    const metric = service.getToolMetrics('tool-a');
    expect(metric?.successCount).toBe(2);
    expect(metric?.errorCount).toBe(0);
  });

  it('increments errorCount on failure', () => {
    service.recordCall('tool-a', 100, false);
    service.recordCall('tool-a', 200, true);
    const metric = service.getToolMetrics('tool-a');
    expect(metric?.successCount).toBe(1);
    expect(metric?.errorCount).toBe(1);
  });

  it('calculates avgDurationMs correctly', () => {
    service.recordCall('tool-a', 100, true);
    service.recordCall('tool-a', 300, true);
    const metric = service.getToolMetrics('tool-a');
    expect(metric?.totalDurationMs).toBe(400);
    expect(metric?.avgDurationMs).toBe(200);
  });

  it('updates lastCalledAt', () => {
    vi.useFakeTimers();
    const now = Date.now();
    service.recordCall('tool-a', 50, true);
    expect(service.getToolMetrics('tool-a')?.lastCalledAt).toBe(now);

    vi.advanceTimersByTime(1000);
    service.recordCall('tool-a', 50, true);
    expect(service.getToolMetrics('tool-a')?.lastCalledAt).toBe(now + 1000);
    vi.useRealTimers();
  });

  it('getMetrics returns all tool metrics', () => {
    service.recordCall('tool-a', 100, true);
    service.recordCall('tool-b', 200, false);
    const all = service.getMetrics();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.name).sort()).toEqual(['tool-a', 'tool-b']);
  });

  it('getToolMetrics returns undefined for unknown tool', () => {
    expect(service.getToolMetrics('unknown')).toBeUndefined();
  });

  it('toPrometheus outputs correct exposition format', () => {
    service.recordCall('tool-a', 100, true);
    service.recordCall('tool-a', 200, false);
    const output = service.toPrometheus();

    expect(output).toContain('# HELP mcp_tool_calls_total Total number of tool calls');
    expect(output).toContain('# TYPE mcp_tool_calls_total counter');
    expect(output).toContain('mcp_tool_calls_total{tool="tool-a"} 2');

    expect(output).toContain('# HELP mcp_tool_errors_total Total number of tool errors');
    expect(output).toContain('# TYPE mcp_tool_errors_total counter');
    expect(output).toContain('mcp_tool_errors_total{tool="tool-a"} 1');

    expect(output).toContain(
      '# HELP mcp_tool_duration_ms_avg Average tool call duration in milliseconds',
    );
    expect(output).toContain('# TYPE mcp_tool_duration_ms_avg gauge');
    expect(output).toContain('mcp_tool_duration_ms_avg{tool="tool-a"} 150.00');

    // Must end with newline
    expect(output.endsWith('\n')).toBe(true);
  });
});
