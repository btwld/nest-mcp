import {
  McpAuthenticatedGuard,
  McpAuthModule,
  McpModule,
  McpTransportType,
} from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { AdminTools } from './admin.tools';
import { AuthDemoController } from './auth-demo.controller';
import { DemoTokenVerifier } from './demo-token.verifier';
import { DynamicRegistrationService } from './dynamic-registration.service';
import { FeatureModule } from './feature/feature.module';
import { ApiKeyGuard } from './guards/api-key.guard';
import { MetricsController } from './metrics.controller';
import { loggingMiddleware } from './middleware/logging.middleware';
import { AssistantPrompts, DataResources, WeatherTools } from './weather.tools';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-server',
      version: '1.0.0',
      description: 'A comprehensive MCP server demonstrating all @nest-mcp features',
      transport: McpTransportType.STREAMABLE_HTTP,
      transportOptions: {
        streamableHttp: {
          endpoint: '/mcp',
          stateless: false,
          // Bearer-token gate (McpBearerGuard); verifier comes from McpAuthModule below.
          oauth: { enabled: true },
        },
      },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true },
      },
      // Global resilience defaults
      resilience: {
        rateLimit: { max: 100, window: '1m' },
        retry: { maxAttempts: 1, backoff: 'fixed' },
      },
      // Global guards (require a verified principal on every non-public call)
      guards: [McpAuthenticatedGuard],
      // Global middleware
      middleware: [loggingMiddleware],
      // Session management
      session: {
        timeout: 1800000, // 30 minutes
        maxConcurrent: 50,
        cleanupInterval: 60000,
      },
      // Metrics
      metrics: {
        enabled: true,
        endpoint: '/metrics',
      },
    }),

    // OAuth resource server: protected-resource metadata + token verification.
    // The playground uses a static-token demo verifier so it works offline;
    // real deployments point `jwks` or `introspection` at their IdP instead.
    McpAuthModule.forRoot({
      resource: 'http://localhost:3000/mcp',
      authorizationServers: ['http://localhost:3000'],
      scopesSupported: ['tools:read', 'admin:read', 'analytics:read'],
      verifier: new DemoTokenVerifier(),
      // Anonymous requests pass the transport gate; non-public tools still
      // require a principal via McpAuthenticatedGuard above.
      required: false,
    }),

    // Feature module
    FeatureModule,
  ],
  controllers: [MetricsController, AuthDemoController],
  providers: [
    WeatherTools,
    DataResources,
    AssistantPrompts,
    AdminTools,
    DynamicRegistrationService,
    ApiKeyGuard,
  ],
})
export class AppModule {}

// Alternative: McpModule.forRootAsync() example (commented)
// @Module({
//   imports: [
//     McpModule.forRootAsync({
//       transport: McpTransportType.STREAMABLE_HTTP,
//       transportOptions: { streamableHttp: { endpoint: '/mcp' } },
//       useFactory: async () => ({
//         name: 'playground-server',
//         version: '1.0.0',
//         transport: McpTransportType.STREAMABLE_HTTP,
//       }),
//     }),
//   ],
// })
// export class AppModuleAsync {}
