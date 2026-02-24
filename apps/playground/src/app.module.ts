import { McpAuthModule, McpModule, McpTransportType } from '@btwld/mcp-server';
import { Module } from '@nestjs/common';
import { AdminTools } from './admin.tools';
import { DynamicRegistrationService } from './dynamic-registration.service';
import { FeatureModule } from './feature/feature.module';
import { ApiKeyGuard } from './guards/api-key.guard';
import { loggingMiddleware } from './middleware/logging.middleware';
import { AssistantPrompts, DataResources, WeatherTools } from './weather.tools';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-server',
      version: '1.0.0',
      description: 'A comprehensive MCP server demonstrating all @btwld/mcp features',
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

    // OAuth 2.1 authentication
    McpAuthModule.forRoot({
      jwtSecret: 'playground-jwt-secret-change-in-production-min-32-chars',
      issuer: 'mcp-playground',
      audience: 'mcp-playground-api',
      accessTokenExpiresIn: '1h',
      refreshTokenExpiresIn: '7d',
      serverUrl: 'http://localhost:3000',
      enableDynamicRegistration: true,
      scopes: ['tools:read', 'tools:write', 'admin:read', 'analytics:read'],
    }),

    // Feature module
    FeatureModule,
  ],
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
