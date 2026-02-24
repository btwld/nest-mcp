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
    let metric = this.metrics.get(toolName);
    if (!metric) {
      metric = {
        name: toolName,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
      };
      this.metrics.set(toolName, metric);
    }

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

  getMetrics(): ToolMetrics[] {
    return Array.from(this.metrics.values());
  }

  getToolMetrics(toolName: string): ToolMetrics | undefined {
    return this.metrics.get(toolName);
  }

  toPrometheus(): string {
    const lines: string[] = [];

    lines.push('# HELP mcp_tool_calls_total Total number of tool calls');
    lines.push('# TYPE mcp_tool_calls_total counter');
    for (const m of this.metrics.values()) {
      lines.push(`mcp_tool_calls_total{tool="${m.name}"} ${m.totalCalls}`);
    }

    lines.push('# HELP mcp_tool_errors_total Total number of tool errors');
    lines.push('# TYPE mcp_tool_errors_total counter');
    for (const m of this.metrics.values()) {
      lines.push(`mcp_tool_errors_total{tool="${m.name}"} ${m.errorCount}`);
    }

    lines.push('# HELP mcp_tool_duration_ms_avg Average tool call duration in milliseconds');
    lines.push('# TYPE mcp_tool_duration_ms_avg gauge');
    for (const m of this.metrics.values()) {
      lines.push(`mcp_tool_duration_ms_avg{tool="${m.name}"} ${m.avgDurationMs.toFixed(2)}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
