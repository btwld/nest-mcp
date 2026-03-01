import 'reflect-metadata';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import { Prompt, Resource, Tool } from '../decorators';
import { MCP_FEATURE_REGISTRATION } from './feature-registration.constants';
import { McpRegistryService } from './registry.service';
import { McpScannerService } from './scanner.service';

// --- Test fixture classes ---

class WeatherTool {
  @Tool({ description: 'Get weather' })
  getWeather() {
    return 'sunny';
  }
}

class AdminTool {
  @Tool({ description: 'Admin action' })
  adminAction() {
    return 'done';
  }
}

class UntaggedTool {
  @Tool({ description: 'Untagged tool' })
  doSomething() {
    return 'ok';
  }
}

class ConfigResource {
  @Resource({ uri: 'file:///config.json', description: 'Config' })
  getConfig() {
    return '{}';
  }
}

class GreetPrompt {
  @Prompt({ description: 'Greet prompt' })
  greet() {
    return { messages: [] };
  }
}

class PlainClass {
  doSomething() {
    return 'not an mcp provider';
  }
}

// --- Helpers ---

function makeModulesContainer(
  modules: Array<{
    providers: Array<{ key: string | symbol; instance: unknown }>;
  }>,
): Map<string, { providers: Map<string | symbol, { instance: unknown }> }> {
  const container = new Map<string, { providers: Map<string | symbol, { instance: unknown }> }>();
  for (let i = 0; i < modules.length; i++) {
    const providerMap = new Map<string | symbol, { instance: unknown }>();
    for (const p of modules[i].providers) {
      providerMap.set(p.key, { instance: p.instance });
    }
    container.set(`module-${i}`, { providers: providerMap });
  }
  return container;
}

function makeScanner(
  modulesContainer: Map<string, { providers: Map<string | symbol, { instance: unknown }> }>,
  serverName: string,
  registry?: McpRegistryService,
): McpScannerService {
  const reg = registry ?? new McpRegistryService();
  const options: McpModuleOptions = {
    name: serverName,
    transport: McpTransportType.STDIO,
  };
  return new McpScannerService(
    modulesContainer as unknown as import('@nestjs/core').ModulesContainer,
    reg,
    options,
  );
}

// --- Tests ---

describe('McpScannerService', () => {
  describe('server-targeting via forFeature', () => {
    it('registers a provider without any server targeting (backward-compatible)', () => {
      const instance = new UntaggedTool();
      const container = makeModulesContainer([
        { providers: [{ key: UntaggedTool, instance }] },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'any-server', registry);
      scanner.onModuleInit();

      expect(registry.getTool('doSomething')).toBeDefined();
    });

    it('registers a provider tagged for the current server name', () => {
      const instance = new WeatherTool();
      const registration = {
        serverName: 'weather-server',
        providerTokens: [WeatherTool],
      };
      const container = makeModulesContainer([
        {
          providers: [
            { key: WeatherTool, instance },
            { key: `${MCP_FEATURE_REGISTRATION}_0`, instance: registration },
          ],
        },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'weather-server', registry);
      scanner.onModuleInit();

      expect(registry.getTool('getWeather')).toBeDefined();
    });

    it('does NOT register a provider tagged for a different server name', () => {
      const instance = new AdminTool();
      const registration = {
        serverName: 'admin-server',
        providerTokens: [AdminTool],
      };
      const container = makeModulesContainer([
        {
          providers: [
            { key: AdminTool, instance },
            { key: `${MCP_FEATURE_REGISTRATION}_1`, instance: registration },
          ],
        },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'weather-server', registry);
      scanner.onModuleInit();

      expect(registry.getTool('adminAction')).toBeUndefined();
    });

    it('handles multiple forFeature calls with different server names correctly', () => {
      const weatherInstance = new WeatherTool();
      const adminInstance = new AdminTool();
      const untaggedInstance = new UntaggedTool();

      const weatherReg = { serverName: 'weather-server', providerTokens: [WeatherTool] };
      const adminReg = { serverName: 'admin-server', providerTokens: [AdminTool] };

      const container = makeModulesContainer([
        {
          providers: [
            { key: WeatherTool, instance: weatherInstance },
            { key: AdminTool, instance: adminInstance },
            { key: UntaggedTool, instance: untaggedInstance },
            { key: `${MCP_FEATURE_REGISTRATION}_0`, instance: weatherReg },
            { key: `${MCP_FEATURE_REGISTRATION}_1`, instance: adminReg },
          ],
        },
      ]);

      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'weather-server', registry);
      scanner.onModuleInit();

      // WeatherTool is tagged for weather-server → included
      expect(registry.getTool('getWeather')).toBeDefined();
      // AdminTool is tagged for admin-server → excluded
      expect(registry.getTool('adminAction')).toBeUndefined();
      // UntaggedTool has no targeting → always included
      expect(registry.getTool('doSomething')).toBeDefined();
    });

    it('handles multiple forFeature calls across different modules', () => {
      const weatherInstance = new WeatherTool();
      const adminInstance = new AdminTool();

      const weatherReg = { serverName: 'weather-server', providerTokens: [WeatherTool] };
      const adminReg = { serverName: 'admin-server', providerTokens: [AdminTool] };

      const container = makeModulesContainer([
        {
          providers: [
            { key: WeatherTool, instance: weatherInstance },
            { key: `${MCP_FEATURE_REGISTRATION}_0`, instance: weatherReg },
          ],
        },
        {
          providers: [
            { key: AdminTool, instance: adminInstance },
            { key: `${MCP_FEATURE_REGISTRATION}_1`, instance: adminReg },
          ],
        },
      ]);

      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'admin-server', registry);
      scanner.onModuleInit();

      // Running as 'admin-server': AdminTool included, WeatherTool excluded
      expect(registry.getTool('adminAction')).toBeDefined();
      expect(registry.getTool('getWeather')).toBeUndefined();
    });

    it('skips wrappers with null instances', () => {
      const container = makeModulesContainer([
        { providers: [{ key: 'SOME_TOKEN', instance: null }] },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'any-server', registry);

      expect(() => scanner.onModuleInit()).not.toThrow();
      expect(registry.getAllTools()).toHaveLength(0);
    });

    it('skips plain classes without MCP decorators', () => {
      const instance = new PlainClass();
      const container = makeModulesContainer([
        { providers: [{ key: PlainClass, instance }] },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'any-server', registry);
      scanner.onModuleInit();

      expect(registry.getAllTools()).toHaveLength(0);
      expect(registry.getAllResources()).toHaveLength(0);
    });
  });

  describe('resource and prompt scanning', () => {
    it('registers a resource provider', () => {
      const instance = new ConfigResource();
      const container = makeModulesContainer([
        { providers: [{ key: ConfigResource, instance }] },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'any-server', registry);
      scanner.onModuleInit();

      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getAllResources()[0].uri).toBe('file:///config.json');
    });

    it('registers a prompt provider', () => {
      const instance = new GreetPrompt();
      const container = makeModulesContainer([
        { providers: [{ key: GreetPrompt, instance }] },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'any-server', registry);
      scanner.onModuleInit();

      expect(registry.getAllPrompts()).toHaveLength(1);
      expect(registry.getAllPrompts()[0].name).toBe('greet');
    });

    it('registers both tools and resources from a mixed container', () => {
      const container = makeModulesContainer([
        {
          providers: [
            { key: WeatherTool, instance: new WeatherTool() },
            { key: ConfigResource, instance: new ConfigResource() },
            { key: GreetPrompt, instance: new GreetPrompt() },
          ],
        },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'my-server', registry);
      scanner.onModuleInit();

      expect(registry.getAllTools()).toHaveLength(1);
      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getAllPrompts()).toHaveLength(1);
    });

    it('excludes resource provider tagged for different server', () => {
      const instance = new ConfigResource();
      const registration = { serverName: 'other-server', providerTokens: [ConfigResource] };
      const container = makeModulesContainer([
        {
          providers: [
            { key: ConfigResource, instance },
            { key: `${MCP_FEATURE_REGISTRATION}_2`, instance: registration },
          ],
        },
      ]);
      const registry = new McpRegistryService();
      const scanner = makeScanner(container, 'my-server', registry);
      scanner.onModuleInit();

      expect(registry.getAllResources()).toHaveLength(0);
    });
  });
});
