import {
  DynamicModule,
  Inject,
  Module,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { McpModule, McpToolBuilder } from '@btwld/mcp-server';
import { MCP_GATEWAY_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import type { McpModuleOptions } from '@btwld/mcp-common';

// Upstream
import { UpstreamManagerService } from './upstream/upstream-manager.service';
import { HealthCheckerService } from './upstream/health-checker.service';
import type { UpstreamConfig } from './upstream/upstream.interface';

// Routing
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { RoutingConfig } from './routing/route-config.interface';

// Policies
import { PolicyEngineService } from './policies/policy-engine.service';
import type { PoliciesConfig } from './policies/policy.interface';

// Cache
import { ResponseCacheService } from './cache/response-cache.service';
import type { CacheConfig } from './cache/cache.interface';

// Transform
import { RequestTransformService } from './transform/request-transform.service';
import { ResponseTransformService } from './transform/response-transform.service';

// Gateway
import { GatewayService } from './gateway.service';

export interface McpGatewayOptions {
  server: McpModuleOptions;
  upstreams: UpstreamConfig[];
  routing?: RoutingConfig;
  policies?: PoliciesConfig;
  cache?: CacheConfig;
}

@Module({})
export class McpGatewayModule implements OnApplicationBootstrap {
  private static readonly logger = new Logger('McpGatewayModule');

  constructor(
    @Inject(MCP_GATEWAY_OPTIONS)
    private readonly options: McpGatewayOptions,
    private readonly gatewayService: GatewayService,
    private readonly upstreamManager: UpstreamManagerService,
    private readonly healthChecker: HealthCheckerService,
    private readonly router: RouterService,
    private readonly policyEngine: PolicyEngineService,
    private readonly responseCache: ResponseCacheService,
    private readonly toolBuilder: McpToolBuilder,
  ) {}

  static forRoot(options: McpGatewayOptions): DynamicModule {
    const serverOptions: McpModuleOptions = {
      ...options.server,
      transport: options.server.transport ?? McpTransportType.STREAMABLE_HTTP,
    };

    return {
      module: McpGatewayModule,
      imports: [McpModule.forRoot(serverOptions)],
      providers: [
        { provide: MCP_GATEWAY_OPTIONS, useValue: options },
        UpstreamManagerService,
        HealthCheckerService,
        RouterService,
        ToolAggregatorService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        GatewayService,
      ],
      exports: [
        GatewayService,
        UpstreamManagerService,
        HealthCheckerService,
        PolicyEngineService,
        ResponseCacheService,
        RequestTransformService,
        ResponseTransformService,
        MCP_GATEWAY_OPTIONS,
      ],
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    // Configure routing
    this.router.configure(
      this.options.upstreams,
      this.options.routing ?? { toolRouting: 'prefix', aggregateToolLists: true },
    );

    // Configure policies
    this.policyEngine.configure(
      this.options.policies ?? { defaultEffect: 'allow', rules: [] },
    );

    // Configure cache
    this.responseCache.configure(
      this.options.cache ?? { enabled: false, defaultTtl: 60000 },
    );

    // Connect to all upstreams
    await this.upstreamManager.connectAll(this.options.upstreams);

    // Start health checks
    this.healthChecker.startAll(this.options.upstreams);

    // Aggregate tools and register them as dynamic tools on the MCP server
    await this.registerUpstreamTools();

    McpGatewayModule.logger.log('MCP Gateway initialized');
  }

  private async registerUpstreamTools(): Promise<void> {
    const tools = await this.gatewayService.listTools();

    for (const tool of tools) {
      this.toolBuilder.register({
        name: tool.name,
        description: tool.description ?? `Proxied tool from ${tool.upstreamName}`,
        inputSchema: tool.inputSchema,
        handler: async (args: Record<string, unknown>) => {
          const result = await this.gatewayService.callTool(tool.name, args);
          return {
            content: result.content as any[],
            isError: result.isError,
          };
        },
      });
    }

    McpGatewayModule.logger.log(`Registered ${tools.length} upstream tools`);
  }
}
