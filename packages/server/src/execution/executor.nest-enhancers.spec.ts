import 'reflect-metadata';
import {
  AuthenticationError,
  AuthorizationError,
  McpError,
  McpTransportType,
  ToolExecutionError,
  ValidationError,
} from '@nest-mcp/common';
import type { McpModuleOptions } from '@nest-mcp/common';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ApplicationConfig, ExternalContextCreator, ModuleRef } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type {
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../discovery/registry.service';
import { mockMcpContext } from '../testing/mock-context';
import { McpExceptionFilterRunner } from './exception-filter.runner';
import { McpExecutorService } from './executor.service';
import { McpNestEnhancerService } from './nest-enhancer.service';

const baseOptions: McpModuleOptions = {
  name: 'test',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
};

/**
 * Stand-in for Nest's `ExternalContextCreator`: the "enhanced" function calls
 * the handler, or rejects with `failure` to simulate a guard, interceptor or
 * pipe throwing before the handler runs.
 */
function makeCreator(failure?: unknown) {
  return {
    getContextModuleKey: vi.fn((_providerClass: unknown) => 'module-key'),
    create: vi.fn(
      (instance: object, callback: (...args: unknown[]) => unknown, ..._rest: unknown[]) =>
        async (...args: unknown[]) => {
          if (failure !== undefined) throw failure;
          return callback.apply(instance, args);
        },
    ),
  };
}

const applicationConfig = {
  getGlobalRequestGuards: () => [],
  getGlobalRequestInterceptors: () => [],
  getGlobalRequestPipes: () => [],
  getGlobalRequestFilters: () => [],
} as unknown as ApplicationConfig;

function setup(
  options: Partial<McpModuleOptions> = { nestEnhancers: true },
  { failure, moduleRef }: { failure?: unknown; moduleRef?: unknown } = {},
) {
  const resolved = { ...baseOptions, ...options };
  const registry = new McpRegistryService();
  const creator = makeCreator(failure);
  const filterRunner = new McpExceptionFilterRunner(new Reflector());
  const legacyFilters = vi.spyOn(filterRunner, 'apply');
  const enhancers = new McpNestEnhancerService(
    resolved,
    creator as unknown as ExternalContextCreator,
    applicationConfig,
  );
  const executor = new McpExecutorService(
    registry,
    filterRunner,
    resolved,
    moduleRef as ModuleRef | undefined,
    enhancers,
  );
  return { registry, creator, executor, legacyFilters };
}

function registerTool(
  registry: McpRegistryService,
  handler: (...args: unknown[]) => unknown,
  extra: Partial<RegisteredTool> = {},
) {
  registry.registerTool({
    name: 'greet',
    description: 'Greet someone',
    methodName: 'greet',
    target: Object,
    instance: { greet: handler },
    ...extra,
  } as RegisteredTool);
}

describe('McpExecutorService with nestEnhancers', () => {
  const ctx = mockMcpContext();

  describe('option off', () => {
    it.each([[{}], [{ nestEnhancers: false }]] as const)(
      'invokes handlers directly and never builds an enhanced invoker (%o)',
      async (options) => {
        const { registry, creator, executor } = setup(options);
        const tool = vi.fn().mockResolvedValue('hello');
        const resource = vi.fn().mockResolvedValue('data');
        const template = vi.fn().mockResolvedValue('one');
        const prompt = vi.fn().mockResolvedValue({ messages: [] });
        registerTool(registry, tool);
        registry.registerResource({
          uri: 'config://app',
          name: 'config',
          methodName: 'read',
          target: Object,
          instance: { read: resource },
        } as RegisteredResource);
        registry.registerResourceTemplate({
          uriTemplate: 'users://{id}',
          name: 'user',
          methodName: 'readOne',
          target: Object,
          instance: { readOne: template },
        } as RegisteredResourceTemplate);
        registry.registerPrompt({
          name: 'summarize',
          description: 'Summarize',
          methodName: 'summarize',
          target: Object,
          instance: { summarize: prompt },
        } as RegisteredPrompt);

        await executor.callTool('greet', { name: 'ada' }, ctx);
        await executor.readResource('config://app', ctx);
        await executor.readResource('users://42', ctx);
        await executor.getPrompt('summarize', { topic: 'x' }, ctx);

        expect(creator.create).not.toHaveBeenCalled();
        expect(tool).toHaveBeenCalledWith({ name: 'ada' }, ctx);
        expect(resource).toHaveBeenCalledWith(new URL('config://app'), ctx);
        expect(template).toHaveBeenCalledWith(new URL('users://42'), { id: '42' }, ctx);
        expect(prompt).toHaveBeenCalledWith({ topic: 'x' }, ctx);
      },
    );

    it('still runs the legacy exception filter runner', async () => {
      const { registry, executor, legacyFilters } = setup({});
      registerTool(registry, vi.fn().mockRejectedValue(new Error('boom')));

      await expect(executor.callTool('greet', {}, ctx)).rejects.toThrow(ToolExecutionError);
      expect(legacyFilters).toHaveBeenCalledTimes(1);
    });
  });

  describe('option on', () => {
    it('refuses to be built without the enhancer service', () => {
      expect(
        () =>
          new McpExecutorService(
            new McpRegistryService(),
            new McpExceptionFilterRunner(new Reflector()),
            { ...baseOptions, nestEnhancers: true },
          ),
      ).toThrow(McpError);
    });

    describe('tools', () => {
      it('runs the handler through one cached invoker with (validatedArgs, ctx)', async () => {
        const { registry, creator, executor } = setup();
        const handler = vi.fn().mockResolvedValue('hello');
        registerTool(registry, handler, {
          parameters: z.object({ name: z.string().default('anon') }),
        });

        const first = await executor.callTool('greet', {}, ctx);
        const second = await executor.callTool('greet', { name: 'ada' }, ctx);

        expect(first).toEqual({ content: [{ type: 'text', text: 'hello' }] });
        expect(second).toEqual({ content: [{ type: 'text', text: 'hello' }] });
        expect(handler).toHaveBeenNthCalledWith(1, { name: 'anon' }, ctx);
        expect(handler).toHaveBeenNthCalledWith(2, { name: 'ada' }, ctx);
        expect(creator.create).toHaveBeenCalledTimes(1);
      });

      it('rebuilds the invoker per call for scoped providers, under the resolution context id', async () => {
        class ScopedTool {
          greet(args: { name: string }) {
            return `hello ${args.name}`;
          }
        }
        const moduleRef = {
          resolve: vi.fn(async () => new ScopedTool()),
          registerRequestByContextId: vi.fn(),
        };
        const { registry, creator, executor } = setup({ nestEnhancers: true }, { moduleRef });
        registry.registerTool({
          name: 'greet',
          description: 'Scoped tool',
          methodName: 'greet',
          target: ScopedTool,
          scopedTarget: ScopedTool,
        } as RegisteredTool);
        const request = { headers: {} };

        const result = await executor.callTool(
          'greet',
          { name: 'ada' },
          mockMcpContext({ request }),
        );
        await executor.callTool('greet', { name: 'bob' }, mockMcpContext({ request }));

        expect(result.content).toEqual([{ type: 'text', text: 'hello ada' }]);
        expect(creator.create).toHaveBeenCalledTimes(2);
        const resolvedUnder = moduleRef.resolve.mock.calls.map((call) => (call as unknown[])[1]);
        const builtUnder = creator.create.mock.calls.map((call) => (call as unknown[])[5]);
        expect(builtUnder).toEqual(resolvedUnder);
        expect(builtUnder[0]).toBeDefined();
        expect(builtUnder[0]).not.toBe(builtUnder[1]);
        expect(moduleRef.registerRequestByContextId).toHaveBeenCalledWith(request, builtUnder[0]);
      });

      it('answers invalid input with an isError result before reaching the enhancers', async () => {
        const { registry, creator, executor } = setup();
        const handler = vi.fn();
        registerTool(registry, handler, { parameters: z.object({ count: z.number() }) });

        const result = await executor.callTool('greet', { count: 'nope' }, ctx);

        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain('Invalid parameters');
        expect(creator.create).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
      });

      it('still validates the result against outputSchema', async () => {
        const { registry, executor } = setup();
        registerTool(registry, vi.fn().mockResolvedValue({ total: 'three' }), {
          outputSchema: z.object({ total: z.number() }),
        });

        await expect(executor.callTool('greet', {}, ctx)).rejects.toThrow(
          'outputSchema validation failed',
        );
      });

      it('surfaces a guard denial as AuthorizationError', async () => {
        const { registry, executor, legacyFilters } = setup(
          { nestEnhancers: true },
          { failure: new ForbiddenException('Forbidden resource') },
        );
        const handler = vi.fn();
        registerTool(registry, handler);

        const error = await executor.callTool('greet', {}, ctx).catch((e) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect(error.message).toBe('Forbidden resource');
        expect(handler).not.toHaveBeenCalled();
        expect(legacyFilters).not.toHaveBeenCalled();
      });

      it('surfaces UnauthorizedException as AuthenticationError', async () => {
        const { registry, executor } = setup(
          { nestEnhancers: true },
          { failure: new UnauthorizedException('token expired') },
        );
        registerTool(registry, vi.fn());

        const error = await executor.callTool('greet', {}, ctx).catch((e) => e);

        expect(error).toBeInstanceOf(AuthenticationError);
        expect(error.message).toBe('token expired');
      });

      it('passes MCP auth errors thrown by enhancers through unwrapped', async () => {
        const denial = new AuthorizationError('admins only');
        const { registry, executor } = setup({ nestEnhancers: true }, { failure: denial });
        registerTool(registry, vi.fn());

        await expect(executor.callTool('greet', {}, ctx)).rejects.toBe(denial);
      });

      it('answers BadRequestException with an isError result listing the messages', async () => {
        const { registry, executor } = setup(
          { nestEnhancers: true },
          { failure: new BadRequestException(['name must be a string', 'age must be positive']) },
        );
        registerTool(registry, vi.fn());

        const result = await executor.callTool('greet', {}, ctx);

        expect(result).toEqual({
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Invalid parameters: name must be a string; age must be positive',
            },
          ],
        });
      });

      it.each([
        ['an Error', new Error('boom'), 'boom'],
        ['another HTTP exception', new NotFoundException('no such thing'), 'no such thing'],
        ['a non-Error value', 'plain text', 'plain text'],
      ])(
        'wraps %s in ToolExecutionError without the legacy filter runner',
        async (_, failure, message) => {
          const { registry, executor, legacyFilters } = setup({ nestEnhancers: true }, { failure });
          registerTool(registry, vi.fn());

          const error = await executor.callTool('greet', {}, ctx).catch((e) => e);

          expect(error).toBeInstanceOf(ToolExecutionError);
          expect(error.message).toBe(`Tool 'greet' execution failed: ${message}`);
          expect(legacyFilters).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['ToolExecutionError', new ToolExecutionError('greet', 'already wrapped')],
        ['ValidationError', new ValidationError('bad input', [])],
      ])('re-throws %s as is', async (_, failure) => {
        const { registry, executor } = setup({ nestEnhancers: true }, { failure });
        registerTool(registry, vi.fn());

        await expect(executor.callTool('greet', {}, ctx)).rejects.toBe(failure);
      });

      it('uses the value an exception filter returned as the tool result', async () => {
        const { registry, creator, executor } = setup();
        creator.create.mockImplementationOnce(() => async () => ({
          isError: true,
          content: [{ type: 'text', text: 'handled by filter' }],
        }));
        registerTool(registry, vi.fn().mockRejectedValue(new Error('boom')));

        await expect(executor.callTool('greet', {}, ctx)).resolves.toEqual({
          isError: true,
          content: [{ type: 'text', text: 'handled by filter' }],
        });
      });
    });

    describe('resources', () => {
      function registerResources(registry: McpRegistryService) {
        const resource = vi.fn().mockResolvedValue('data');
        const template = vi.fn().mockResolvedValue('one');
        registry.registerResource({
          uri: 'config://app',
          name: 'config',
          methodName: 'read',
          target: Object,
          instance: { read: resource },
        } as RegisteredResource);
        registry.registerResourceTemplate({
          uriTemplate: 'users://{id}',
          name: 'user',
          methodName: 'readOne',
          target: Object,
          instance: { readOne: template },
        } as RegisteredResourceTemplate);
        return { resource, template };
      }

      it('runs resource and template handlers through cached invokers with their own signatures', async () => {
        const { registry, creator, executor } = setup();
        const { resource, template } = registerResources(registry);

        const fixed = await executor.readResource('config://app', ctx);
        await executor.readResource('config://app', ctx);
        const templated = await executor.readResource('users://42', ctx);
        await executor.readResource('users://7', ctx);

        expect(fixed).toEqual({ contents: [{ uri: 'config://app', text: 'data' }] });
        expect(templated).toEqual({ contents: [{ uri: 'users://42', text: 'one' }] });
        expect(resource).toHaveBeenCalledWith(new URL('config://app'), ctx);
        expect(template).toHaveBeenCalledWith(new URL('users://42'), { id: '42' }, ctx);
        expect(template).toHaveBeenCalledWith(new URL('users://7'), { id: '7' }, ctx);
        expect(creator.create).toHaveBeenCalledTimes(2);
      });

      it.each([
        ['ForbiddenException', new ForbiddenException('nope'), AuthorizationError],
        ['UnauthorizedException', new UnauthorizedException('who?'), AuthenticationError],
        ['BadRequestException', new BadRequestException('bad id'), ValidationError],
      ])('maps %s to the MCP error model', async (_, failure, expected) => {
        const { registry, executor, legacyFilters } = setup({ nestEnhancers: true }, { failure });
        registerResources(registry);

        await expect(executor.readResource('config://app', ctx)).rejects.toBeInstanceOf(expected);
        await expect(executor.readResource('users://42', ctx)).rejects.toBeInstanceOf(expected);
        expect(legacyFilters).not.toHaveBeenCalled();
      });

      it('re-throws other errors as is, without the legacy filter runner', async () => {
        const failure = new Error('boom');
        const protocolError = new McpError('custom', -32001);
        const first = setup({ nestEnhancers: true }, { failure });
        const second = setup({ nestEnhancers: true }, { failure: protocolError });
        registerResources(first.registry);
        registerResources(second.registry);

        await expect(first.executor.readResource('config://app', ctx)).rejects.toBe(failure);
        await expect(second.executor.readResource('config://app', ctx)).rejects.toBe(protocolError);
        expect(first.legacyFilters).not.toHaveBeenCalled();
      });
    });

    describe('prompts', () => {
      function registerPrompt(
        registry: McpRegistryService,
        handler: (...args: unknown[]) => unknown,
      ) {
        registry.registerPrompt({
          name: 'summarize',
          description: 'Summarize',
          methodName: 'summarize',
          target: Object,
          instance: { summarize: handler },
          parameters: z.object({ topic: z.string() }),
        } as RegisteredPrompt);
      }

      it('runs the handler through one cached invoker with (validatedArgs, ctx)', async () => {
        const { registry, creator, executor } = setup();
        const messages = { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] };
        const handler = vi.fn().mockResolvedValue(messages);
        registerPrompt(registry, handler);

        await expect(executor.getPrompt('summarize', { topic: 'x' }, ctx)).resolves.toBe(messages);
        await executor.getPrompt('summarize', { topic: 'y' }, ctx);

        expect(handler).toHaveBeenNthCalledWith(1, { topic: 'x' }, ctx);
        expect(creator.create).toHaveBeenCalledTimes(1);
      });

      it('rejects invalid arguments before reaching the enhancers', async () => {
        const { registry, creator, executor } = setup();
        registerPrompt(registry, vi.fn());

        await expect(executor.getPrompt('summarize', {}, ctx)).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(creator.create).not.toHaveBeenCalled();
      });

      it('maps a guard denial to AuthorizationError without the legacy filter runner', async () => {
        const { registry, executor, legacyFilters } = setup(
          { nestEnhancers: true },
          { failure: new ForbiddenException('nope') },
        );
        registerPrompt(registry, vi.fn());

        const error = await executor.getPrompt('summarize', { topic: 'x' }, ctx).catch((e) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect(error.message).toBe('nope');
        expect(legacyFilters).not.toHaveBeenCalled();
      });
    });
  });
});
