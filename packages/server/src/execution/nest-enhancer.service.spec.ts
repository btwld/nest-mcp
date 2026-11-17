import 'reflect-metadata';
import {
  AuthenticationError,
  AuthorizationError,
  McpError,
  McpTransportType,
  ValidationError,
} from '@nest-mcp/common';
import type { McpModuleOptions } from '@nest-mcp/common';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UseGuards, UseInterceptors } from '@nestjs/common';
import type { ArgumentsHost, CanActivate } from '@nestjs/common';
import type { ApplicationConfig, ExternalContextCreator } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { ParamsFactory } from '@nestjs/core/helpers/external-context-creator';
import { mockMcpContext } from '../testing/mock-context';
import { MCP_CONTEXT_TYPE, McpArgumentsHost } from './mcp-arguments-host';
import {
  type McpEnhancedTarget,
  McpNestEnhancerService,
  describeHttpException,
  mapEnhancerException,
} from './nest-enhancer.service';

const baseOptions: McpModuleOptions = {
  name: 'test',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
};

type ScopedEnhancers = Partial<Record<'guards' | 'interceptors' | 'pipes' | 'filters', unknown[]>>;

/** Stand-in for Nest's creator: the "enhanced" function just calls the handler. */
function makeCreator() {
  return {
    getContextModuleKey: vi.fn((_providerClass: unknown) => 'module-key'),
    create: vi.fn(
      (instance: object, callback: (...args: unknown[]) => unknown, ..._rest: unknown[]) =>
        async (...args: unknown[]) =>
          callback.apply(instance, args),
    ),
  };
}

function makeService(
  options: Partial<McpModuleOptions> = { nestEnhancers: true },
  scoped: ScopedEnhancers = {},
) {
  const creator = makeCreator();
  const config = {
    getGlobalRequestGuards: () => scoped.guards ?? [],
    getGlobalRequestInterceptors: () => scoped.interceptors ?? [],
    getGlobalRequestPipes: () => scoped.pipes ?? [],
    getGlobalRequestFilters: () => scoped.filters ?? [],
  };
  const service = new McpNestEnhancerService(
    { ...baseOptions, ...options },
    creator as unknown as ExternalContextCreator,
    config as unknown as ApplicationConfig,
  );
  return { service, creator };
}

class WeatherTools {
  forecast(args: { city: string }) {
    return `sunny in ${args.city}`;
  }

  read(uri: URL) {
    return `read ${uri.href}`;
  }

  readOne(uri: URL, params: { id: string }) {
    return `read ${uri.href} for ${params.id}`;
  }
}

function targetOf(
  layout: McpEnhancedTarget['layout'],
  methodName: string,
  instance: object = new WeatherTools(),
): McpEnhancedTarget {
  return { layout, capability: { methodName }, instance: instance as Record<string, unknown> };
}

describe('McpNestEnhancerService', () => {
  const ctx = mockMcpContext();

  describe('enabled', () => {
    it('is off unless the option is set', () => {
      expect(makeService({}).service.enabled).toBe(false);
      expect(makeService({ nestEnhancers: false }).service.enabled).toBe(false);
      expect(makeService({ nestEnhancers: true }).service.enabled).toBe(true);
    });
  });

  describe('invoke', () => {
    it("builds the invoker with guards, interceptors and filters on and the 'mcp' context type", async () => {
      const { service, creator } = makeService();
      const target = targetOf('tool', 'forecast');

      const result = await service.invoke(target, { kind: 'tool', name: 'forecast' }, [
        { city: 'Lisbon' },
        ctx,
      ]);

      expect(result).toBe('sunny in Lisbon');
      expect(creator.create).toHaveBeenCalledTimes(1);
      const [instance, callback, methodName, , , contextId, inquirerId, enhancers, contextType] =
        creator.create.mock.calls[0] as unknown[];
      expect(instance).toBe(target.instance);
      expect(callback).toBe(WeatherTools.prototype.forecast);
      expect(methodName).toBe('forecast');
      expect(contextId).toBeUndefined();
      expect(inquirerId).toBeUndefined();
      expect(enhancers).toEqual({ guards: true, interceptors: true, filters: true });
      expect(contextType).toBe(MCP_CONTEXT_TYPE);
    });

    it('builds the invoker once per capability for singleton providers', async () => {
      const { service, creator } = makeService();
      const target = targetOf('tool', 'forecast');
      const call = { kind: 'tool', name: 'forecast' } as const;

      await service.invoke(target, call, [{ city: 'Lisbon' }, ctx]);
      await service.invoke(target, call, [{ city: 'Porto' }, ctx]);
      await service.invoke({ ...target }, call, [{ city: 'Faro' }, ctx]);

      expect(creator.create).toHaveBeenCalledTimes(1);
    });

    it('builds a separate invoker for each capability', async () => {
      const { service, creator } = makeService();
      const instance = new WeatherTools();

      await service.invoke(targetOf('tool', 'forecast', instance), { kind: 'tool', name: 'a' }, [
        { city: 'Lisbon' },
        ctx,
      ]);
      await service.invoke(
        targetOf('resource', 'read', instance),
        { kind: 'resource', name: 'config://app' },
        [new URL('config://app'), ctx],
      );

      expect(creator.create).toHaveBeenCalledTimes(2);
    });

    it('rebuilds the invoker per call, under the given context id, for scoped providers', async () => {
      const { service, creator } = makeService();
      const capability = { methodName: 'forecast' };
      const call = { kind: 'tool', name: 'forecast' } as const;
      const first = { id: 1 };
      const second = { id: 2 };

      for (const contextId of [first, second]) {
        await service.invoke(
          {
            layout: 'tool',
            capability,
            instance: new WeatherTools() as unknown as Record<string, unknown>,
            contextId,
          },
          call,
          [{ city: 'Lisbon' }, ctx],
        );
      }

      expect(creator.create).toHaveBeenCalledTimes(2);
      expect(creator.create.mock.calls[0][5]).toBe(first);
      expect(creator.create.mock.calls[1][5]).toBe(second);
    });

    it('identifies the running capability to enhancers', async () => {
      const { service, creator } = makeService();
      const seen: Array<{ kind: string; name: string; args: unknown; context: unknown }> = [];
      creator.create.mockImplementationOnce(
        (instance: object, callback: (...args: unknown[]) => unknown) =>
          async (...args: unknown[]) => {
            const host = new ExecutionContextHost(args);
            host.setType(MCP_CONTEXT_TYPE);
            const mcp = McpArgumentsHost.create(host as ArgumentsHost);
            seen.push({
              kind: mcp.getKind(),
              name: mcp.getName(),
              args: mcp.getArgs(),
              context: mcp.getContext(),
            });
            return callback.apply(instance, args);
          },
      );
      const args = { city: 'Lisbon' };

      await service.invoke(targetOf('tool', 'forecast'), { kind: 'tool', name: 'weather' }, [
        args,
        ctx,
      ]);

      expect(seen).toEqual([{ kind: 'tool', name: 'weather', args, context: ctx }]);
    });

    it('fails when the handler is not a function', () => {
      const { service } = makeService();

      expect(() =>
        service.invoke(targetOf('tool', 'missing'), { kind: 'tool', name: 'missing' }, []),
      ).toThrow(McpError);
    });
  });

  describe('handler parameters', () => {
    function paramsOf(creator: ReturnType<typeof makeCreator>) {
      const [instance, , methodName, key, factory] = creator.create.mock.calls[0] as unknown as [
        object,
        unknown,
        string,
        string | undefined,
        ParamsFactory | undefined,
      ];
      const metadata =
        key === undefined
          ? undefined
          : (Reflect.getMetadata(key, instance.constructor, methodName) as Record<
              string,
              { index: number }
            >);
      return { key, factory, metadata };
    }

    /** `[paramtype, index]` pairs, in handler order. */
    const layoutOf = (metadata: Record<string, { index: number }> | undefined) =>
      Object.entries(metadata ?? {})
        .map(([key, { index }]) => [Number(key.split(':')[0]), index])
        .sort((a, b) => a[1] - b[1]);

    it('describes tool handlers as (body, context)', async () => {
      const { service, creator } = makeService();
      const args = { city: 'Lisbon' };

      await service.invoke(targetOf('tool', 'forecast'), { kind: 'tool', name: 'a' }, [args, ctx]);

      const { factory, metadata } = paramsOf(creator);
      const [[body], [context]] = layoutOf(metadata);
      expect(layoutOf(metadata)).toHaveLength(2);
      expect(factory?.exchangeKeyForValue(body, undefined, [args, ctx])).toBe(args);
      expect(factory?.exchangeKeyForValue(context, undefined, [args, ctx])).toBe(ctx);
    });

    it('describes prompt handlers like tool handlers', async () => {
      const { service, creator } = makeService();

      await service.invoke(targetOf('prompt', 'forecast'), { kind: 'prompt', name: 'a' }, [
        { city: 'Lisbon' },
        ctx,
      ]);
      const prompt = layoutOf(paramsOf(creator).metadata);

      creator.create.mockClear();
      await service.invoke(targetOf('tool', 'forecast'), { kind: 'tool', name: 'a' }, [
        { city: 'Lisbon' },
        ctx,
      ]);
      expect(layoutOf(paramsOf(creator).metadata)).toEqual(prompt);
    });

    it('describes resource handlers as (uri, context)', async () => {
      const { service, creator } = makeService();
      const uri = new URL('config://app');

      await service.invoke(targetOf('resource', 'read'), { kind: 'resource', name: uri.href }, [
        uri,
        ctx,
      ]);

      const { factory, metadata } = paramsOf(creator);
      const [[first], [second]] = layoutOf(metadata);
      expect(layoutOf(metadata)).toHaveLength(2);
      expect(factory?.exchangeKeyForValue(first, undefined, [uri, ctx])).toBe(uri);
      expect(factory?.exchangeKeyForValue(second, undefined, [uri, ctx])).toBe(ctx);
    });

    it('describes resource-template handlers as (uri, param, context)', async () => {
      const { service, creator } = makeService();
      const uri = new URL('users://42');
      const variables = { id: '42' };
      const callArgs = [uri, variables, ctx];

      await service.invoke(
        targetOf('resource-template', 'readOne'),
        { kind: 'resource', name: uri.href },
        callArgs,
      );

      const { factory, metadata } = paramsOf(creator);
      const [[first], [second], [third]] = layoutOf(metadata);
      expect(layoutOf(metadata)).toHaveLength(3);
      expect(factory?.exchangeKeyForValue(first, undefined, callArgs)).toBe(uri);
      expect(factory?.exchangeKeyForValue(second, undefined, callArgs)).toBe(variables);
      expect(factory?.exchangeKeyForValue(third, undefined, callArgs)).toBe(ctx);
    });

    it('passes arguments straight through for handlers that live on plain objects', async () => {
      const { service, creator } = makeService();
      const handler = vi.fn().mockResolvedValue('ok');
      const args = { city: 'Lisbon' };

      const result = await service.invoke(
        targetOf('tool', 'dynamic', { dynamic: handler }),
        { kind: 'tool', name: 'dynamic' },
        [args, ctx],
      );

      const { key, factory } = paramsOf(creator);
      expect(key).toBeUndefined();
      expect(factory).toBeUndefined();
      expect(handler).toHaveBeenCalledWith(args, ctx);
      expect(result).toBe('ok');
    });
  });

  describe('providers Nest cannot resolve enhancers for', () => {
    class AdminGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    class AuditInterceptor {
      intercept() {}
    }

    @UseInterceptors(AuditInterceptor)
    class ByClass {
      @UseGuards(AdminGuard)
      run() {
        return 'ran';
      }
    }

    class ByInstance {
      @UseGuards(new AdminGuard())
      run() {
        return 'ran';
      }
    }

    function invokeUnregistered(instance: object, methodName = 'run') {
      const { service, creator } = makeService();
      creator.getContextModuleKey.mockReturnValue('');
      const run = () =>
        service.invoke(targetOf('tool', methodName, instance), { kind: 'tool', name: 'run' }, [
          { city: 'Lisbon' },
          ctx,
        ]);
      return { run, creator };
    }

    it('refuses a handler whose class-referenced enhancers would be dropped', () => {
      const { run, creator } = invokeUnregistered(new ByClass());

      expect(run).toThrow(McpError);
      expect(run).toThrow(/ByClass\.run.*AdminGuard, AuditInterceptor.*not listed by class/);
      expect(creator.create).not.toHaveBeenCalled();
    });

    it('accepts enhancers passed as instances', async () => {
      const { run } = invokeUnregistered(new ByInstance());

      await expect(run()).resolves.toBe('ran');
    });

    it('accepts handlers without method- or class-level enhancers', async () => {
      const undecorated = invokeUnregistered(new WeatherTools(), 'forecast');
      const plainObject = invokeUnregistered({ run: () => 'ok' });

      await expect(undecorated.run()).resolves.toBe('sunny in Lisbon');
      await expect(plainObject.run()).resolves.toBe('ok');
    });

    it('accepts class-referenced enhancers when the class is a registered provider', async () => {
      const { service } = makeService();

      await expect(
        service.invoke(targetOf('tool', 'run', new ByClass()), { kind: 'tool', name: 'run' }, [
          {},
          ctx,
        ]),
      ).resolves.toBe('ran');
    });
  });

  describe('onApplicationBootstrap', () => {
    it('accepts an app without scoped app-level enhancers', () => {
      expect(() => makeService().service.onApplicationBootstrap()).not.toThrow();
    });

    it.each([
      ['guards', 'APP_GUARD'],
      ['interceptors', 'APP_INTERCEPTOR'],
      ['pipes', 'APP_PIPE'],
      ['filters', 'APP_FILTER'],
    ] as const)('refuses to start with scoped app-level %s', (kind, token) => {
      const { service } = makeService({ nestEnhancers: true }, { [kind]: [{}] });

      expect(() => service.onApplicationBootstrap()).toThrow(McpError);
      expect(() => service.onApplicationBootstrap()).toThrow(token);
    });

    it('ignores scoped app-level enhancers while the option is off', () => {
      const { service } = makeService({}, { guards: [{}] });

      expect(() => service.onApplicationBootstrap()).not.toThrow();
    });
  });

  describe('mapEnhancerException', () => {
    it('maps UnauthorizedException to AuthenticationError', () => {
      const mapped = mapEnhancerException(new UnauthorizedException('token expired'));

      expect(mapped).toBeInstanceOf(AuthenticationError);
      expect((mapped as Error).message).toBe('token expired');
    });

    it('maps ForbiddenException to AuthorizationError', () => {
      const mapped = mapEnhancerException(new ForbiddenException('admins only'));

      expect(mapped).toBeInstanceOf(AuthorizationError);
      expect((mapped as Error).message).toBe('admins only');
    });

    it('maps BadRequestException to ValidationError', () => {
      const mapped = mapEnhancerException(new BadRequestException(['a is required', 'b is odd']));

      expect(mapped).toBeInstanceOf(ValidationError);
      expect((mapped as Error).message).toBe('a is required; b is odd');
    });

    it('leaves other errors untouched', () => {
      const notFound = new NotFoundException();
      const plain = new Error('boom');

      expect(mapEnhancerException(notFound)).toBe(notFound);
      expect(mapEnhancerException(plain)).toBe(plain);
      expect(mapEnhancerException('text')).toBe('text');
    });
  });

  describe('describeHttpException', () => {
    it('uses a string response as is', () => {
      expect(describeHttpException(new HttpException('teapot', 418))).toBe('teapot');
    });

    it('uses the message of an object response', () => {
      expect(describeHttpException(new ForbiddenException('nope'))).toBe('nope');
    });

    it('joins per-field validation messages', () => {
      expect(describeHttpException(new BadRequestException(['a', 'b']))).toBe('a; b');
    });

    it('falls back to the default message', () => {
      expect(describeHttpException(new ForbiddenException())).toBe('Forbidden');
    });
  });
});
