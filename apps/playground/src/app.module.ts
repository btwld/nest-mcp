import {
  JwtAuthGuard,
  McpAuthModule,
  type McpGuardClass,
  McpModule,
  McpTransportType,
} from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { AdminTools } from './admin.tools';
import { AuthDemoController } from './auth-demo.controller';
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
      // Global guards (run JwtAuthGuard on every tool/resource/prompt call)
      guards: [JwtAuthGuard as unknown as McpGuardClass],
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

    // OAuth2 / JWT authentication
    McpAuthModule.forRoot({
      jwtSecret: process.env.JWT_SECRET || 'playground-demo-secret-key-at-least-32chars!',
      issuer: 'http://localhost:3000',
      serverUrl: 'http://localhost:3000',
      resourceUrl: 'http://localhost:3000/mcp',
      enableDynamicRegistration: true,
      scopes: ['tools:read', 'admin:read', 'analytics:read'],
      validateUser: async () => ({ id: 'demo-user' }),
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
