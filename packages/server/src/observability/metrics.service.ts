import { Injectable, Logger } from '@nestjs/common';

export interface ToolMetrics {
  name: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastCalledAt?: number;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly metrics = new Map<string, ToolMetrics>();

  recordCall(toolName: string, durationMs: number, success: boolean): void {
    const metric = this.getOrCreateMetric(toolName);

    metric.totalCalls++;
    metric.totalDurationMs += durationMs;
    metric.avgDurationMs = metric.totalDurationMs / metric.totalCalls;
    metric.lastCalledAt = Date.now();

    if (success) {
      metric.successCount++;
    } else {
      metric.errorCount++;
    }
  }

  private getOrCreateMetric(toolName: string): ToolMetrics {
    const existing = this.metrics.get(toolName);
    if (existing) return existing;
    const metric: ToolMetrics = {
      name: toolName,
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
    };
    this.metrics.set(toolName, metric);
    return metric;
  }

  getMetrics(): ToolMetrics[] {
    return Array.from(this.metrics.values());
  }

  getToolMetrics(toolName: string): ToolMetrics | undefined {
    return this.metrics.get(toolName);
  }

  toPrometheus(): string {
    const metrics = Array.from(this.metrics.values());
    const sections = [
      {
        help: 'mcp_tool_calls_total',
        type: 'counter',
        helpText: 'Total number of tool calls',
        fn: (m: ToolMetrics) => `mcp_tool_calls_total{tool="${m.name}"} ${m.totalCalls}`,
      },
      {
        help: 'mcp_tool_errors_total',
        type: 'counter',
        helpText: 'Total number of tool errors',
        fn: (m: ToolMetrics) => `mcp_tool_errors_total{tool="${m.name}"} ${m.errorCount}`,
      },
      {
        help: 'mcp_tool_duration_ms_avg',
        type: 'gauge',
        helpText: 'Average tool call duration in milliseconds',
        fn: (m: ToolMetrics) =>
          `mcp_tool_duration_ms_avg{tool="${m.name}"} ${m.avgDurationMs.toFixed(2)}`,
      },
    ];
    const lines = sections.flatMap(({ help, type, helpText, fn }) => [
      `# HELP ${help} ${helpText}`,
      `# TYPE ${help} ${type}`,
      ...metrics.map(fn),
    ]);
    return `${lines.join('\n')}\n`;
  }
}
