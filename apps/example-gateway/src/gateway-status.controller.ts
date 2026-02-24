// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { PolicyEngineService, UpstreamManagerService } from '@btwld/mcp-gateway';
import { Controller, Get, Param } from '@nestjs/common';

@Controller('gateway')
export class GatewayStatusController {
  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly policyEngine: PolicyEngineService,
  ) {}

  @Get('status')
  getStatus() {
    const playgroundStatus = this.upstreamManager.getStatus('playground');
    return {
      gateway: {
        name: 'gateway-server',
        version: '1.0.0',
        uptime: process.uptime(),
      },
      upstreams: {
        playground: playgroundStatus,
      },
    };
  }

  @Get('policy/:tool')
  evaluatePolicy(@Param('tool') tool: string) {
    const result = this.policyEngine.evaluate(tool);
    return {
      tool,
      ...result,
    };
  }
}
