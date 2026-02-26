import 'reflect-metadata';
import {
  CircuitBreaker,
  Guards,
  Prompt,
  Public,
  RateLimit,
  Resource,
  ResourceTemplate,
  Retry,
  Roles,
  Scopes,
  Tool,
} from '../decorators';
import { McpRegistryService } from './registry.service';
import type { RegisteredPrompt, RegisteredResource, RegisteredTool } from './registry.service';

// --- Test fixture classes ---

class TestTools {
  @Tool({ description: 'A test tool' })
  myTool() {
    return 'ok';
  }

  @Tool({ name: 'custom-name', description: 'Named tool' })
  @Public()
  @Scopes(['read', 'write'])
  @Roles(['admin'])
  namedTool() {
    return 'ok';
  }
}

class TestResources {
  @Resource({
    uri: 'file:///config.json',
    name: 'config',
    description: 'App config',
    mimeType: 'application/json',
  })
  getConfig() {
    return {};
  }
}

class TestResourceTemplates {
  @ResourceTemplate({
    uriTemplate: 'file:///users/{userId}',
    name: 'user',
    description: 'User resource',
    mimeType: 'application/json',
  })
  getUser() {
    return {};
  }
}

class TestPrompts {
  @Prompt({ name: 'greet', description: 'A greeting prompt' })
  greet() {
    return { messages: [] };
  }
}

class TestResilienceTools {
  @Tool({ description: 'resilient tool' })
  @RateLimit({ max: 10, window: '1m', perUser: true })
  @Retry({ maxAttempts: 3, backoff: 'exponential', initialDelay: 100, maxDelay: 5000 })
  @CircuitBreaker({ errorThreshold: 5, timeWindow: 60000 })
  resilientTool() {
    return 'ok';
  }
}

class DuplicateTools {
  @Tool({ name: 'dup', description: 'first' })
  first() {
    return 'first';
  }

  @Tool({ name: 'dup', description: 'second' })
  second() {
    return 'second';
  }
}

// --- Tests ---

describe('McpRegistryService', () => {
  let registry: McpRegistryService;

  beforeEach(() => {
    registry = new McpRegistryService();
  });

  describe('registerProvider', () => {
    it('scans @Tool methods and registers them', () => {
      const instance = new TestTools();
      registry.registerProvider(instance);

      expect(registry.hasTools).toBe(true);
      expect(registry.getAllTools()).toHaveLength(2);

      const myTool = registry.getTool('myTool');
      expect(myTool).toBeDefined();
      expect(myTool?.description).toBe('A test tool');
      expect(myTool?.methodName).toBe('myTool');
      expect(myTool?.instance).toBe(instance);

      const namedTool = registry.getTool('custom-name');
      expect(namedTool).toBeDefined();
      expect(namedTool?.description).toBe('Named tool');
    });

    it('scans @Resource methods and registers them', () => {
      const instance = new TestResources();
      registry.registerProvider(instance);

      expect(registry.hasResources).toBe(true);
      expect(registry.getAllResources()).toHaveLength(1);

      const resource = registry.getResource('file:///config.json');
      expect(resource).toBeDefined();
      expect(resource?.name).toBe('config');
      expect(resource?.mimeType).toBe('application/json');
      expect(resource?.instance).toBe(instance);
    });

    it('scans @ResourceTemplate methods and registers them', () => {
      const instance = new TestResourceTemplates();
      registry.registerProvider(instance);

      expect(registry.hasResourceTemplates).toBe(true);
      expect(registry.getAllResourceTemplates()).toHaveLength(1);

      const tmpl = registry.getResourceTemplate('file:///users/{userId}');
      expect(tmpl).toBeDefined();
      expect(tmpl?.name).toBe('user');
      expect(tmpl?.instance).toBe(instance);
    });

    it('scans @Prompt methods and registers them', () => {
      const instance = new TestPrompts();
      registry.registerProvider(instance);

      expect(registry.hasPrompts).toBe(true);
      expect(registry.getAllPrompts()).toHaveLength(1);

      const prompt = registry.getPrompt('greet');
      expect(prompt).toBeDefined();
      expect(prompt?.description).toBe('A greeting prompt');
      expect(prompt?.instance).toBe(instance);
    });

    it('enriches tool metadata with auth decorators', () => {
      const instance = new TestTools();
      registry.registerProvider(instance);

      const tool = registry.getTool('custom-name');
      expect(tool).toBeDefined();
      expect(tool?.isPublic).toBe(true);
      expect(tool?.requiredScopes).toEqual(['read', 'write']);
      expect(tool?.requiredRoles).toEqual(['admin']);
    });

    it('enriches tool metadata with resilience decorators', () => {
      const instance = new TestResilienceTools();
      registry.registerProvider(instance);

      const tool = registry.getTool('resilientTool');
      expect(tool).toBeDefined();
      expect(tool?.rateLimit).toEqual({ max: 10, window: '1m', perUser: true });
      expect(tool?.retry).toEqual({
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelay: 100,
        maxDelay: 5000,
      });
      expect(tool?.circuitBreaker).toEqual({
        errorThreshold: 5,
        timeWindow: 60000,
      });
    });

    it('warns on duplicate tool names', () => {
      const instance = new DuplicateTools();
      const warnSpy = vi.spyOn(
        (registry as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );

      registry.registerProvider(instance);

      expect(warnSpy).toHaveBeenCalledWith('Duplicate tool name: dup. Overwriting.');
      // The second one overwrites the first
      const tool = registry.getTool('dup');
      expect(tool?.description).toBe('second');
    });

    it('skips null/undefined instances', () => {
      expect(() => registry.registerProvider(null)).not.toThrow();
      expect(() => registry.registerProvider(undefined)).not.toThrow();
      expect(registry.hasTools).toBe(false);
    });

    it('skips instances without constructor', () => {
      const noConstructor = Object.create(null);
      expect(() => registry.registerProvider(noConstructor)).not.toThrow();
      expect(registry.hasTools).toBe(false);
    });

    it('does NOT emit events on registerProvider', () => {
      const spy = vi.fn();
      registry.events.on('tool.registered', spy);
      registry.events.on('resource.registered', spy);
      registry.events.on('prompt.registered', spy);

      registry.registerProvider(new TestTools());
      registry.registerProvider(new TestResources());
      registry.registerProvider(new TestPrompts());

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('accessors', () => {
    it('getAllTools returns all registered tools', () => {
      const instance = new TestTools();
      registry.registerProvider(instance);

      const tools = registry.getAllTools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('myTool');
      expect(names).toContain('custom-name');
    });

    it('getTool returns undefined for unknown tool', () => {
      expect(registry.getTool('nonexistent')).toBeUndefined();
    });

    it('getResource returns undefined for unknown resource', () => {
      expect(registry.getResource('nonexistent')).toBeUndefined();
    });

    it('getPrompt returns undefined for unknown prompt', () => {
      expect(registry.getPrompt('nonexistent')).toBeUndefined();
    });
  });

  describe('has* getters', () => {
    it('returns false when empty', () => {
      expect(registry.hasTools).toBe(false);
      expect(registry.hasResources).toBe(false);
      expect(registry.hasResourceTemplates).toBe(false);
      expect(registry.hasPrompts).toBe(false);
    });

    it('returns true after registration', () => {
      registry.registerProvider(new TestTools());
      registry.registerProvider(new TestResources());
      registry.registerProvider(new TestResourceTemplates());
      registry.registerProvider(new TestPrompts());

      expect(registry.hasTools).toBe(true);
      expect(registry.hasResources).toBe(true);
      expect(registry.hasResourceTemplates).toBe(true);
      expect(registry.hasPrompts).toBe(true);
    });
  });

  describe('dynamic registerTool/unregisterTool', () => {
    it('registers and retrieves a tool dynamically', () => {
      const tool: RegisteredTool = {
        name: 'dynamic-tool',
        description: 'A dynamically registered tool',
        methodName: 'handle',
        target: Object,
        instance: {},
      };

      registry.registerTool(tool);

      expect(registry.hasTools).toBe(true);
      expect(registry.getTool('dynamic-tool')).toBe(tool);
    });

    it('unregisters a tool by name', () => {
      const tool: RegisteredTool = {
        name: 'temp-tool',
        description: 'Temporary',
        methodName: 'handle',
        target: Object,
        instance: {},
      };

      registry.registerTool(tool);
      expect(registry.hasTools).toBe(true);

      const result = registry.unregisterTool('temp-tool');
      expect(result).toBe(true);
      expect(registry.getTool('temp-tool')).toBeUndefined();
      expect(registry.hasTools).toBe(false);
    });

    it('returns false when unregistering nonexistent tool', () => {
      const result = registry.unregisterTool('nonexistent');
      expect(result).toBe(false);
    });

    it('emits tool.registered event on registerTool', () => {
      const spy = vi.fn();
      registry.events.on('tool.registered', spy);

      const tool: RegisteredTool = {
        name: 'dyn-tool',
        description: 'Dynamic',
        methodName: 'handle',
        target: Object,
        instance: {},
      };
      registry.registerTool(tool);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(tool);
    });

    it('emits tool.unregistered event on unregisterTool', () => {
      const spy = vi.fn();
      registry.events.on('tool.unregistered', spy);

      const tool: RegisteredTool = {
        name: 'dyn-tool',
        description: 'Dynamic',
        methodName: 'handle',
        target: Object,
        instance: {},
      };
      registry.registerTool(tool);
      registry.unregisterTool('dyn-tool');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('dyn-tool');
    });

    it('does not emit tool.unregistered when tool does not exist', () => {
      const spy = vi.fn();
      registry.events.on('tool.unregistered', spy);

      registry.unregisterTool('nonexistent');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('dynamic registerResource/unregisterResource', () => {
    it('registers and retrieves a resource dynamically', () => {
      const resource: RegisteredResource = {
        uri: 'file:///dynamic.txt',
        name: 'dynamic',
        description: 'Dynamic resource',
        methodName: 'read',
        target: Object,
        instance: {},
      };

      registry.registerResource(resource);

      expect(registry.hasResources).toBe(true);
      expect(registry.getResource('file:///dynamic.txt')).toBe(resource);
    });

    it('unregisters a resource by uri', () => {
      const resource: RegisteredResource = {
        uri: 'file:///temp.txt',
        name: 'temp',
        methodName: 'read',
        target: Object,
        instance: {},
      };

      registry.registerResource(resource);
      expect(registry.hasResources).toBe(true);

      const result = registry.unregisterResource('file:///temp.txt');
      expect(result).toBe(true);
      expect(registry.getResource('file:///temp.txt')).toBeUndefined();
      expect(registry.hasResources).toBe(false);
    });

    it('returns false when unregistering nonexistent resource', () => {
      const result = registry.unregisterResource('nonexistent');
      expect(result).toBe(false);
    });

    it('emits resource.registered event on registerResource', () => {
      const spy = vi.fn();
      registry.events.on('resource.registered', spy);

      const resource: RegisteredResource = {
        uri: 'file:///dyn.txt',
        name: 'dyn',
        methodName: 'read',
        target: Object,
        instance: {},
      };
      registry.registerResource(resource);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(resource);
    });

    it('emits resource.unregistered event on unregisterResource', () => {
      const spy = vi.fn();
      registry.events.on('resource.unregistered', spy);

      const resource: RegisteredResource = {
        uri: 'file:///dyn.txt',
        name: 'dyn',
        methodName: 'read',
        target: Object,
        instance: {},
      };
      registry.registerResource(resource);
      registry.unregisterResource('file:///dyn.txt');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('file:///dyn.txt');
    });

    it('does not emit resource.unregistered when resource does not exist', () => {
      const spy = vi.fn();
      registry.events.on('resource.unregistered', spy);

      registry.unregisterResource('nonexistent');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('dynamic registerPrompt/unregisterPrompt', () => {
    it('registers and retrieves a prompt dynamically', () => {
      const prompt: RegisteredPrompt = {
        name: 'dynamic-prompt',
        description: 'Dynamic prompt',
        methodName: 'generate',
        target: Object,
        instance: {},
      };

      registry.registerPrompt(prompt);

      expect(registry.hasPrompts).toBe(true);
      expect(registry.getPrompt('dynamic-prompt')).toBe(prompt);
    });

    it('unregisters a prompt by name', () => {
      const prompt: RegisteredPrompt = {
        name: 'temp-prompt',
        description: 'Temp',
        methodName: 'generate',
        target: Object,
        instance: {},
      };

      registry.registerPrompt(prompt);
      expect(registry.hasPrompts).toBe(true);

      const result = registry.unregisterPrompt('temp-prompt');
      expect(result).toBe(true);
      expect(registry.getPrompt('temp-prompt')).toBeUndefined();
      expect(registry.hasPrompts).toBe(false);
    });

    it('returns false when unregistering nonexistent prompt', () => {
      const result = registry.unregisterPrompt('nonexistent');
      expect(result).toBe(false);
    });

    it('emits prompt.registered event on registerPrompt', () => {
      const spy = vi.fn();
      registry.events.on('prompt.registered', spy);

      const prompt: RegisteredPrompt = {
        name: 'dyn-prompt',
        description: 'Dynamic',
        methodName: 'generate',
        target: Object,
        instance: {},
      };
      registry.registerPrompt(prompt);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(prompt);
    });

    it('emits prompt.unregistered event on unregisterPrompt', () => {
      const spy = vi.fn();
      registry.events.on('prompt.unregistered', spy);

      const prompt: RegisteredPrompt = {
        name: 'dyn-prompt',
        description: 'Dynamic',
        methodName: 'generate',
        target: Object,
        instance: {},
      };
      registry.registerPrompt(prompt);
      registry.unregisterPrompt('dyn-prompt');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('dyn-prompt');
    });

    it('does not emit prompt.unregistered when prompt does not exist', () => {
      const spy = vi.fn();
      registry.events.on('prompt.unregistered', spy);

      registry.unregisterPrompt('nonexistent');

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
