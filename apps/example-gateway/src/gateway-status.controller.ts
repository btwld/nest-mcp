// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import {
  PolicyEngineService,
  PromptAggregatorService,
  ResourceAggregatorService,
  ToolAggregatorService,
  UpstreamManagerService,
} from '@btwld/mcp-gateway';
import { Controller, Get, Param } from '@nestjs/common';

@Controller('gateway')
export class GatewayStatusController {
  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly policyEngine: PolicyEngineService,
    private readonly toolAggregator: ToolAggregatorService,
    private readonly resourceAggregator: ResourceAggregatorService,
    private readonly promptAggregator: PromptAggregatorService,
  ) {}

  @Get('status')
  getStatus() {
    const upstreamNames = this.upstreamManager.getAllNames();
    const upstreams: Record<string, unknown> = {};
    for (const name of upstreamNames) {
      upstreams[name] = this.upstreamManager.getStatus(name);
    }

    return {
      gateway: {
        name: 'gateway-server',
        version: '1.0.0',
        uptime: process.uptime(),
      },
      upstreams,
    };
  }

  @Get('tools')
  getTools() {
    const tools = this.toolAggregator.getCachedTools();
    return {
      totalTools: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        upstream: t.upstreamName,
        originalName: t.originalName,
      })),
    };
  }

  @Get('resources')
  getResources() {
    const resources = this.resourceAggregator.getCachedResources();
    return {
      totalResources: resources.length,
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        upstream: r.upstreamName,
        originalUri: r.originalUri,
      })),
    };
  }

  @Get('prompts')
  getPrompts() {
    const prompts = this.promptAggregator.getCachedPrompts();
    return {
      totalPrompts: prompts.length,
      prompts: prompts.map((p) => ({
        name: p.name,
        description: p.description,
        upstream: p.upstreamName,
        originalName: p.originalName,
        arguments: p.arguments,
      })),
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
