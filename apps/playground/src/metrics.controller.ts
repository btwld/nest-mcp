// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { MetricsService, SessionManager } from '@btwld/mcp-server';
import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly sessionManager: SessionManager,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getPrometheus(): string {
    return this.metricsService.toPrometheus();
  }

  @Get('metrics/json')
  getMetricsJson() {
    return {
      tools: this.metricsService.getMetrics(),
      sessions: {
        active: this.sessionManager.getActiveSessions(),
      },
    };
  }

  @Get('sessions')
  getSessions() {
    return {
      activeSessions: this.sessionManager.getActiveSessions(),
    };
  }
}
