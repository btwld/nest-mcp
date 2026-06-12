import 'reflect-metadata';
import { McpError, type McpModuleOptions, McpTransportType } from '@nest-mcp/common';
import { describe, expect, it } from 'vitest';
import { McpBearerGuard } from './auth/guards/mcp-bearer.guard';
import { MCP_OAUTH_GATE_CHECK, McpModule, createOauthGateCheckProvider } from './mcp.module';

describe('McpModule', () => {
  describe('forRoot', () => {
    it('includes StreamableHttpService and controller for streamable-http transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
      });

      expect(mod.controllers).toHaveLength(1);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
    });

    it('includes SseService and two controllers for SSE transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.SSE,
      });

      expect(mod.controllers).toHaveLength(2);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('SseService');
    });

    it('includes StdioService and no controllers for STDIO transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO,
      });

      expect(mod.controllers).toHaveLength(0);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StdioService');
    });

    it('applies controllerGuards to the streamable HTTP controller', () => {
      class EdgeGuard {
        canActivate(): boolean {
          return true;
        }
      }
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: { streamableHttp: { controllerGuards: [EdgeGuard] } },
      });

      const [controller] = mod.controllers ?? [];
      expect(Reflect.getMetadata('__guards__', controller)).toEqual([EdgeGuard]);
    });

    it('applies controllerDecorators to the streamable HTTP controller', () => {
      const tag: ClassDecorator = (target) => {
        Reflect.defineMetadata('custom:tag', 'from-forRoot', target);
      };
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: { streamableHttp: { controllerDecorators: [tag] } },
      });

      const [controller] = mod.controllers ?? [];
      expect(Reflect.getMetadata('custom:tag', controller)).toBe('from-forRoot');
    });
  });

  describe('forRootAsync', () => {
    it('includes StreamableHttpService and controller for streamable-http transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STREAMABLE_HTTP,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      });

      expect(mod.controllers).toHaveLength(1);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
    });

    it('includes SseService and two controllers for SSE transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.SSE,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.SSE,
        }),
      });

      expect(mod.controllers).toHaveLength(2);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('SseService');
    });

    it('includes StdioService and no controllers for STDIO transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        }),
      });

      expect(mod.controllers).toHaveLength(0);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StdioService');
    });

    it('respects custom transportOptions for SSE endpoints', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.SSE,
        transportOptions: {
          sse: { endpoint: '/custom-sse', messagesEndpoint: '/custom-messages' },
        },
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.SSE,
        }),
      });

      // Should still have 2 controllers for SSE
      expect(mod.controllers).toHaveLength(2);
    });

    it('respects custom transportOptions for streamable-http endpoint', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: {
          streamableHttp: { endpoint: '/custom-mcp' },
        },
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      });

      expect(mod.controllers).toHaveLength(1);
    });

    it('applies static controllerGuards and controllerDecorators to the streamable HTTP controller', () => {
      class EdgeGuard {
        canActivate(): boolean {
          return true;
        }
      }
      const tag: ClassDecorator = (target) => {
        Reflect.defineMetadata('custom:tag', 'from-forRootAsync', target);
      };
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: {
          streamableHttp: { controllerGuards: [EdgeGuard], controllerDecorators: [tag] },
        },
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      });

      const [controller] = mod.controllers ?? [];
      expect(Reflect.getMetadata('__guards__', controller)).toEqual([EdgeGuard]);
      expect(Reflect.getMetadata('custom:tag', controller)).toBe('from-forRootAsync');
    });

    it('passes through imports from async options', () => {
      const fakeModule = { module: class FakeModule {} };
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        imports: [
          fakeModule as unknown as Parameters<typeof McpModule.forRootAsync>[0]['imports'] extends
            | (infer U)[]
            | undefined
            ? U
            : never,
        ],
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        }),
      });

      expect(mod.imports).toContain(fakeModule);
    });

    it('creates MCP_OPTIONS provider from useFactory', () => {
      const factory = () => ({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO as const,
      });

      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        useFactory: factory,
        inject: ['CONFIG_SERVICE'],
      });

      const optionsProvider = (mod.providers as Record<string, unknown>[]).find(
        (p: Record<string, unknown>) =>
          p.provide?.toString?.() === 'Symbol(MCP_OPTIONS)' ||
          p.provide === Symbol.for('MCP_OPTIONS'),
      );
      // The MCP_OPTIONS provider should exist (it's an injection token)
      expect(mod.providers?.length).toBeGreaterThan(0);
    });
  });

  describe('multiple transports (array)', () => {
    it('includes services and controllers for both streamable-http and SSE', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
      });

      // 1 streamable-http controller + 2 SSE controllers
      expect(mod.controllers).toHaveLength(3);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
      expect(providerNames).toContain('SseService');
    });

    it('forRootAsync supports array of transports', () => {
      const mod = McpModule.forRootAsync({
        transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        }),
      });

      expect(mod.controllers).toHaveLength(3);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
      expect(providerNames).toContain('SseService');
    });
  });

  describe('oauth bearer guard wiring', () => {
    class EdgeGuard {
      canActivate(): boolean {
        return true;
      }
    }

    describe('forRoot — streamable HTTP', () => {
      it('prepends McpBearerGuard to controllerGuards when oauth is enabled', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: { oauth: { enabled: true }, controllerGuards: [EdgeGuard] },
          },
        });

        const [controller] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', controller)).toEqual([McpBearerGuard, EdgeGuard]);
      });

      it('applies only McpBearerGuard when oauth is enabled without controllerGuards', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: { oauth: { enabled: true } },
          },
        });

        const [controller] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', controller)).toEqual([McpBearerGuard]);
      });

      it('does not prepend McpBearerGuard when oauth.enabled is false', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: { oauth: { enabled: false }, controllerGuards: [EdgeGuard] },
          },
        });

        const [controller] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', controller)).toEqual([EdgeGuard]);
      });
    });

    describe('forRoot — SSE', () => {
      it('applies McpBearerGuard to both SSE controllers when sse.oauth is enabled', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
          transportOptions: {
            sse: { oauth: { enabled: true } },
          },
        });

        // Controller order: [streamable, sseGet, sseMessages]
        const [streamable, sseGet, sseMessages] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', sseGet)).toEqual([McpBearerGuard]);
        expect(Reflect.getMetadata('__guards__', sseMessages)).toEqual([McpBearerGuard]);
        // streamable oauth gate is off → untouched
        expect(Reflect.getMetadata('__guards__', streamable)).toBeUndefined();
      });

      it('leaves SSE controllers without __guards__ metadata when sse.oauth is not enabled', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.SSE,
        });

        const [sseGet, sseMessages] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', sseGet)).toBeUndefined();
        expect(Reflect.getMetadata('__guards__', sseMessages)).toBeUndefined();
      });
    });

    describe('forRootAsync', () => {
      it('prepends McpBearerGuard from static transportOptions when oauth is enabled', () => {
        const mod = McpModule.forRootAsync({
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: { oauth: { enabled: true }, controllerGuards: [EdgeGuard] },
          },
          useFactory: () => ({
            name: 'test',
            version: '1.0',
            transport: McpTransportType.STREAMABLE_HTTP,
          }),
        });

        const [controller] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', controller)).toEqual([McpBearerGuard, EdgeGuard]);
      });

      it('applies only McpBearerGuard when oauth is enabled without controllerGuards', () => {
        const mod = McpModule.forRootAsync({
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: { oauth: { enabled: true } },
          },
          useFactory: () => ({
            name: 'test',
            version: '1.0',
            transport: McpTransportType.STREAMABLE_HTTP,
          }),
        });

        const [controller] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', controller)).toEqual([McpBearerGuard]);
      });

      it('applies McpBearerGuard to both SSE controllers from static transportOptions when sse.oauth is enabled', () => {
        const mod = McpModule.forRootAsync({
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
          transportOptions: {
            sse: { oauth: { enabled: true } },
          },
          useFactory: () => ({
            name: 'test',
            version: '1.0',
            transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
          }),
        });

        // Controller order: [streamable, sseGet, sseMessages]
        const [streamable, sseGet, sseMessages] = mod.controllers ?? [];
        expect(Reflect.getMetadata('__guards__', sseGet)).toEqual([McpBearerGuard]);
        expect(Reflect.getMetadata('__guards__', sseMessages)).toEqual([McpBearerGuard]);
        // streamable oauth gate is off → untouched
        expect(Reflect.getMetadata('__guards__', streamable)).toBeUndefined();
      });
    });

    describe('providers', () => {
      it('forRoot registers McpBearerGuard as a provider', () => {
        const mod = McpModule.forRoot({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        });

        expect(mod.providers).toContain(McpBearerGuard);
      });

      it('forRootAsync registers McpBearerGuard as a provider', () => {
        const mod = McpModule.forRootAsync({
          transport: McpTransportType.STDIO,
          useFactory: () => ({
            name: 'test',
            version: '1.0',
            transport: McpTransportType.STDIO,
          }),
        });

        expect(mod.providers).toContain(McpBearerGuard);
      });
    });
  });

  describe('oauth gate consistency check', () => {
    const findGateCheckProvider = (mod: ReturnType<typeof McpModule.forRoot>) =>
      (mod.providers as { provide?: unknown }[]).find((p) => p.provide === MCP_OAUTH_GATE_CHECK);

    it('forRoot includes the MCP_OAUTH_GATE_CHECK provider', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO,
      });

      expect(findGateCheckProvider(mod)).toBeDefined();
    });

    it('forRootAsync includes the MCP_OAUTH_GATE_CHECK provider', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        }),
      });

      expect(findGateCheckProvider(mod)).toBeDefined();
    });

    describe('createOauthGateCheckProvider', () => {
      const getFactory = (staticGates: { streamableHttp: boolean; sse: boolean }) => {
        const provider = createOauthGateCheckProvider(staticGates) as {
          provide: symbol;
          useFactory: (options: McpModuleOptions) => boolean;
          inject: unknown[];
        };
        expect(provider.provide).toBe(MCP_OAUTH_GATE_CHECK);
        return provider.useFactory;
      };

      const baseOptions: McpModuleOptions = {
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
      };

      it('returns true when resolved oauth gates match the static gates', () => {
        const useFactory = getFactory({ streamableHttp: true, sse: false });

        const result = useFactory({
          ...baseOptions,
          transportOptions: { streamableHttp: { oauth: { enabled: true } } },
        });

        expect(result).toBe(true);
      });

      it('throws McpError mentioning streamableHttp when oauth is enabled at runtime but was statically off', () => {
        const useFactory = getFactory({ streamableHttp: false, sse: false });

        const call = () =>
          useFactory({
            ...baseOptions,
            transportOptions: { streamableHttp: { oauth: { enabled: true } } },
          });

        expect(call).toThrow(McpError);
        expect(call).toThrow(/streamableHttp/);
      });

      it('throws when oauth was statically on but resolved options omit oauth entirely', () => {
        const useFactory = getFactory({ streamableHttp: true, sse: false });

        const call = () => useFactory(baseOptions);

        expect(call).toThrow(McpError);
        expect(call).toThrow(/streamableHttp/);
      });

      it('throws McpError mentioning sse on an SSE gate mismatch', () => {
        const useFactory = getFactory({ streamableHttp: false, sse: false });

        const call = () =>
          useFactory({
            ...baseOptions,
            transport: McpTransportType.SSE,
            transportOptions: { sse: { oauth: { enabled: true } } },
          });

        expect(call).toThrow(McpError);
        expect(call).toThrow(/sse/);
      });

      it('returns true when oauth is configured nowhere and static gates are off', () => {
        const useFactory = getFactory({ streamableHttp: false, sse: false });

        expect(useFactory(baseOptions)).toBe(true);
      });
    });
  });

  describe('forFeature', () => {
    it('returns a module with the given providers', () => {
      class FakeProvider {}
      const mod = McpModule.forFeature([FakeProvider]);

      expect(mod.providers).toContain(FakeProvider);
      expect(mod.exports).toContain(FakeProvider);
    });

    it('uses McpModule when serverName is not provided', () => {
      class FakeProvider {}
      const mod = McpModule.forFeature([FakeProvider]);
      expect(mod.module).toBe(McpModule);
    });

    describe('with options object', () => {
      it('includes imports in returned module without serverName', () => {
        class FakeProvider {}
        class FakeImportModule {}
        const mod = McpModule.forFeature([FakeProvider], { imports: [FakeImportModule] });

        expect(mod.module).toBe(McpModule);
        expect(mod.imports).toContain(FakeImportModule);
        expect(mod.providers).toContain(FakeProvider);
        expect(mod.exports).toContain(FakeProvider);
      });

      it('defaults imports to empty array when options object has no imports', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], {});

        expect(mod.module).toBe(McpModule);
        expect(mod.imports).toEqual([]);
      });

      it('includes imports with serverName using McpFeatureModule', async () => {
        const { McpFeatureModule } = await import('./discovery/mcp-feature.module');
        class FakeProvider {}
        class FakeImportModule {}
        const mod = McpModule.forFeature([FakeProvider], {
          imports: [FakeImportModule],
          serverName: 'my-server',
        });

        expect(mod.module).toBe(McpFeatureModule);
        expect(mod.imports).toContain(FakeImportModule);
        expect(mod.global).toBe(true);
      });

      it('creates registration token when serverName is provided via options', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], {
          serverName: 'target-server',
          imports: [],
        });
        const registrationProvider = (
          mod.providers as { provide: string; useValue: unknown }[]
        ).find(
          (p) => typeof p.provide === 'string' && p.provide.startsWith('MCP_FEATURE_REGISTRATION_'),
        );
        expect(registrationProvider).toBeDefined();
        expect(registrationProvider?.useValue).toMatchObject({
          serverName: 'target-server',
          providerTokens: [FakeProvider],
        });
      });

      it('passes through multiple imports', () => {
        class FakeProvider {}
        class ModuleA {}
        class ModuleB {}
        class ModuleC {}
        const mod = McpModule.forFeature([FakeProvider], {
          imports: [ModuleA, ModuleB, ModuleC],
        });

        expect(mod.imports).toEqual([ModuleA, ModuleB, ModuleC]);
      });
    });

    describe('with serverName (named-server targeting)', () => {
      it('uses McpFeatureModule instead of McpModule', async () => {
        const { McpFeatureModule } = await import('./discovery/mcp-feature.module');
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'my-server');
        expect(mod.module).toBe(McpFeatureModule);
      });

      it('registers providers', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'my-server');
        expect(mod.providers).toEqual(expect.arrayContaining([FakeProvider]));
      });

      it('exports providers', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'my-server');
        expect(mod.exports).toEqual(expect.arrayContaining([FakeProvider]));
      });

      it('adds a registration token provider with serverName and providerTokens', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'target-server');
        const registrationProvider = (
          mod.providers as { provide: string; useValue: unknown }[]
        ).find(
          (p) => typeof p.provide === 'string' && p.provide.startsWith('MCP_FEATURE_REGISTRATION_'),
        );
        expect(registrationProvider).toBeDefined();
        expect(registrationProvider?.useValue).toMatchObject({
          serverName: 'target-server',
          providerTokens: [FakeProvider],
        });
      });

      it('exports the registration token', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'target-server');
        const hasRegistrationToken = (mod.exports as string[]).some(
          (e) => typeof e === 'string' && e.startsWith('MCP_FEATURE_REGISTRATION_'),
        );
        expect(hasRegistrationToken).toBe(true);
      });

      it('sets global to true', () => {
        class FakeProvider {}
        const mod = McpModule.forFeature([FakeProvider], 'my-server');
        expect(mod.global).toBe(true);
      });

      it('each call produces a unique registration token', () => {
        class A {}
        class B {}
        const mod1 = McpModule.forFeature([A], 'server-a');
        const mod2 = McpModule.forFeature([B], 'server-b');

        const getToken = (mod: ReturnType<typeof McpModule.forFeature>) =>
          (mod.providers as { provide: string }[]).find(
            (p) =>
              typeof p.provide === 'string' && p.provide.startsWith('MCP_FEATURE_REGISTRATION_'),
          )?.provide;

        expect(getToken(mod1)).not.toBe(getToken(mod2));
      });
    });
  });
});
