import 'reflect-metadata';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCP_AUTHORIZATION_ERROR, McpTransportType } from '@nest-mcp/common';
import type { McpExecutionContext, McpGuard, McpMiddleware } from '@nest-mcp/common';
import {
  Catch,
  Inject,
  Injectable,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import type {
  ArgumentMetadata,
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  ModuleMetadata,
  NestInterceptor,
  PipeTransform,
} from '@nestjs/common';
import { APP_GUARD, REQUEST } from '@nestjs/core';
import { map, tap } from 'rxjs';
import { z } from 'zod';
import {
  Guards,
  McpArgumentsHost,
  McpModule,
  McpToolBuilder,
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
  UseMiddleware,
} from '../../src';
import type { McpContextType } from '../../src';
import { connectStreamable, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

/** What ran, in order. Shared by both apps in this file; reset before each test. */
const trace: string[] = [];

/** Trace entries produced by MCP capability calls (drops the HTTP-level ones). */
const mcpTrace = () => trace.filter((entry) => entry !== 'app-guard:http');

interface McpRequestInfo {
  headers?: Record<string, string | string[] | undefined>;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first.text;
}

// ---- Enhancers ----

/** App-level guard. Also sees the HTTP requests that carry the MCP messages. */
@Injectable()
class AppGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType<McpContextType>() !== 'mcp') {
      trace.push(`app-guard:${context.getType()}`);
      return true;
    }
    const mcp = McpArgumentsHost.create(context);
    trace.push(`app-guard:mcp:${mcp.getKind()}:${mcp.getName()}`);
    return true;
  }
}

/** Method-level guard that lets the caller decide through the tool arguments. */
@Injectable()
class AllowFlagGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    trace.push(`allow-flag-guard:${context.getType()}`);
    return McpArgumentsHost.create(context).getArgs<{ allow: boolean }>().allow;
  }
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** Allows a templated resource read for user `1` only. */
@Injectable()
class OwnUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const mcp = McpArgumentsHost.create(context);
    trace.push(`own-user-guard:${mcp.getKind()}:${mcp.getName()}`);
    return mcp.getArgs<{ id: string }>().id === '1';
  }
}

@Injectable()
class PublicTopicGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const mcp = McpArgumentsHost.create(context);
    return mcp.getKind() === 'prompt' && mcp.getArgs<{ topic: string }>().topic !== 'secret';
  }
}

/** Wraps a handler result in a tag named after the capability. */
@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const name = McpArgumentsHost.create(context).getName();
    return next.handle().pipe(map((value) => `<${name}>${String(value)}</${name}>`));
  }
}

@Injectable()
class UppercaseNamePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body') return value;
    const args = value as { name: string };
    return { ...args, name: args.name.toUpperCase() };
  }
}

/** Records how Nest describes each handler parameter to pipes. */
@Injectable()
class DescribeParamsPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    trace.push(`param:${metadata.type}:${metadata.metatype?.name ?? 'none'}`);
    return value;
  }
}

class NameDto {
  name = '';
}

class OutOfStockError extends Error {}

@Injectable()
class ErrorFormatter {
  format(error: Error): string {
    return `formatted[${error.message}]`;
  }
}

/** Exception filter that depends on an injected provider. */
@Catch(OutOfStockError)
class OutOfStockFilter implements ExceptionFilter {
  constructor(private readonly formatter: ErrorFormatter) {}

  catch(error: OutOfStockError, host: ArgumentsHost) {
    const mcp = McpArgumentsHost.create(host);
    return {
      isError: true,
      content: [{ type: 'text', text: `${mcp.getName()}: ${this.formatter.format(error)}` }],
    };
  }
}

// ---- Pipeline-order probes ----

class LegacyGuard implements McpGuard {
  canActivate(): boolean {
    trace.push('mcp-guard');
    return true;
  }
}

class LegacyDenyGuard implements McpGuard {
  canActivate(): boolean {
    return false;
  }
}

const traceMiddleware: McpMiddleware = async (_ctx, _args, next) => {
  trace.push('middleware:before');
  const result = await next();
  trace.push('middleware:after');
  return result;
};

@Injectable()
class TraceGuard implements CanActivate {
  canActivate(): boolean {
    trace.push('nest-guard');
    return true;
  }
}

@Injectable()
class TraceInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    trace.push('interceptor:before');
    return next.handle().pipe(tap(() => trace.push('interceptor:after')));
  }
}

@Injectable()
class TracePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    trace.push(`pipe:${metadata.type}`);
    return value;
  }
}

// ---- Request-scoped enhancers ----

@Injectable({ scope: Scope.REQUEST })
class TenantGuard implements CanActivate {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  canActivate(): boolean {
    return this.request?.headers?.['x-tenant'] !== 'blocked';
  }
}

@Injectable({ scope: Scope.REQUEST })
class TenantStampInterceptor implements NestInterceptor {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  intercept(_context: ExecutionContext, next: CallHandler) {
    const tenant = String(this.request?.headers?.['x-tenant'] ?? 'anonymous');
    return next.handle().pipe(map((value) => `${String(value)} (stamped for ${tenant})`));
  }
}

// ---- Capabilities ----

@Injectable()
class EnhancedCapabilities {
  @Tool({
    name: 'guarded',
    description: 'Protected by a method-level Nest guard',
    parameters: z.object({ allow: z.boolean() }),
  })
  @UseGuards(AllowFlagGuard)
  guarded() {
    trace.push('handler:guarded');
    return 'granted';
  }

  @Tool({
    name: 'legacy-guarded',
    description: 'Denied by the built-in guard mechanism',
    parameters: z.object({}),
  })
  @Guards([LegacyDenyGuard])
  legacyGuarded() {
    return 'granted';
  }

  @Tool({
    name: 'shout',
    description: 'Greets with a piped name',
    parameters: z.object({ name: z.string() }),
  })
  @UsePipes(UppercaseNamePipe)
  shout(args: { name: string }, ctx: McpExecutionContext) {
    return `hello ${args.name} over ${ctx.transport}`;
  }

  @Tool({
    name: 'typed',
    description: 'Arguments typed with a class',
    parameters: z.object({ name: z.string() }),
  })
  @UsePipes(DescribeParamsPipe)
  typed(args: NameDto, _ctx: McpExecutionContext) {
    return `typed ${args.name}`;
  }

  @Tool({ name: 'fragile', description: 'Throws a handled error', parameters: z.object({}) })
  @UseFilters(OutOfStockFilter)
  fragile(): never {
    throw new OutOfStockError('no widgets left');
  }

  @Tool({ name: 'broken', description: 'Throws an unhandled error', parameters: z.object({}) })
  @UseFilters(OutOfStockFilter)
  broken(): never {
    throw new Error('kaboom');
  }

  @Tool({
    name: 'ordered',
    description: 'Records the order of every pipeline stage',
    parameters: z.object({ name: z.string() }),
  })
  @Guards([LegacyGuard])
  @UseMiddleware(traceMiddleware)
  @UseGuards(TraceGuard)
  @UseInterceptors(TraceInterceptor)
  @UsePipes(TracePipe)
  ordered() {
    trace.push('handler');
    return 'ok';
  }

  @Resource({ uri: 'vault://secret', name: 'secret', description: 'Always denied' })
  @UseGuards(DenyGuard)
  secret() {
    return 'classified';
  }

  @ResourceTemplate({ uriTemplate: 'users://{id}', name: 'user', description: 'A user record' })
  @UseGuards(OwnUserGuard)
  user(uri: URL, params: { id: string }) {
    return `user ${params.id} at ${uri.href}`;
  }

  @Prompt({
    name: 'brief',
    description: 'Brief on a topic',
    parameters: z.object({ topic: z.string() }),
  })
  @UseGuards(PublicTopicGuard)
  brief({ topic }: { topic: string }) {
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `brief me on ${topic}` } }],
    };
  }
}

@Injectable()
@UseInterceptors(EnvelopeInterceptor)
class WrappedTools {
  @Tool({ name: 'wrapped', description: 'Result is wrapped', parameters: z.object({}) })
  wrapped() {
    return 'payload';
  }
}

@Injectable({ scope: Scope.REQUEST })
@UseInterceptors(EnvelopeInterceptor)
class TenantTools {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  @Tool({ name: 'whoami', description: 'Echo the calling tenant', parameters: z.object({}) })
  @UseGuards(TenantGuard)
  whoami() {
    return `tenant:${String(this.request?.headers?.['x-tenant'] ?? 'anonymous')}`;
  }
}

/** Default-scoped provider whose interceptor is request-scoped. */
@Injectable()
class StampedTools {
  @Tool({ name: 'stamped', description: 'Stamped per request', parameters: z.object({}) })
  @UseInterceptors(TenantStampInterceptor)
  stamped() {
    return 'document';
  }
}

function appMetadata(nestEnhancers: boolean | undefined): ModuleMetadata {
  return {
    imports: [
      McpModule.forRoot({
        name: 'enhancers-server',
        version: '1.0.0',
        transport: McpTransportType.STREAMABLE_HTTP,
        ...(nestEnhancers === undefined ? {} : { nestEnhancers }),
      }),
    ],
    providers: [
      EnhancedCapabilities,
      WrappedTools,
      TenantTools,
      StampedTools,
      ErrorFormatter,
      { provide: APP_GUARD, useClass: AppGuard },
    ],
  };
}

describe('NestJS enhancers e2e', () => {
  beforeEach(() => {
    trace.length = 0;
  });

  describe('with nestEnhancers on', () => {
    let server: E2eApp;
    let client: Client;

    beforeAll(async () => {
      server = await createMcpApp(appMetadata(true));
      server.app.get(McpToolBuilder).register({
        name: 'runtime-echo',
        description: 'Registered through the builder',
        parameters: z.object({ value: z.string() }),
        handler: async (args) => `echo:${String(args.value)}`,
      });
      client = await connectStreamable(server.baseUrl);
    });

    afterAll(async () => {
      await client.close();
      await server.close();
    });

    describe('guards', () => {
      it("runs a method-level guard with an 'mcp' context and lets the call through", async () => {
        const result = await client.callTool({ name: 'guarded', arguments: { allow: true } });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toBe('granted');
        expect(trace).toContain('allow-flag-guard:mcp');
        expect(trace).toContain('handler:guarded');
      });

      it('denies the call when the guard returns false', async () => {
        const result = await client.callTool({ name: 'guarded', arguments: { allow: false } });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe('Forbidden resource');
        expect(trace).toContain('allow-flag-guard:mcp');
        expect(trace).not.toContain('handler:guarded');
      });

      it('reports the denial the way the built-in guards do', async () => {
        const nest = await client.callTool({ name: 'guarded', arguments: { allow: false } });
        const builtIn = await client.callTool({ name: 'legacy-guarded', arguments: {} });

        expect(builtIn.isError).toBe(true);
        expect(textOf(builtIn)).toContain('authorization denied by guard');
        expect(Object.keys(nest).sort()).toEqual(Object.keys(builtIn).sort());
        expect((nest.content as unknown[]).length).toBe((builtIn.content as unknown[]).length);
      });

      it('runs an app-level guard for tool calls', async () => {
        await client.callTool({ name: 'guarded', arguments: { allow: true } });

        expect(mcpTrace()).toEqual([
          'app-guard:mcp:tool:guarded',
          'allow-flag-guard:mcp',
          'handler:guarded',
        ]);
      });

      it('runs an app-level guard for capabilities registered through the builders', async () => {
        const result = await client.callTool({ name: 'runtime-echo', arguments: { value: 'x' } });

        expect(textOf(result)).toBe('echo:x');
        expect(mcpTrace()).toEqual(['app-guard:mcp:tool:runtime-echo']);
      });

      it('answers invalid input before any guard runs', async () => {
        const result = await client.callTool({ name: 'guarded', arguments: { allow: 'yes' } });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('allow');
        expect(mcpTrace()).toEqual([]);
      });
    });

    describe('interceptors, pipes and filters', () => {
      it('wraps the result with a class-level interceptor', async () => {
        const result = await client.callTool({ name: 'wrapped', arguments: {} });

        expect(textOf(result)).toBe('<wrapped>payload</wrapped>');
      });

      it('transforms the input with a pipe and leaves the execution context alone', async () => {
        const result = await client.callTool({ name: 'shout', arguments: { name: 'ada' } });

        expect(textOf(result)).toBe(`hello ADA over ${McpTransportType.STREAMABLE_HTTP}`);
      });

      it('describes the input to pipes as a body parameter with its declared class', async () => {
        const result = await client.callTool({ name: 'typed', arguments: { name: 'ada' } });

        expect(textOf(result)).toBe('typed ada');
        expect(trace).toContain('param:body:NameDto');
        expect(trace).toContain('param:custom:Object');
      });

      it('handles a thrown error with a filter that has injected dependencies', async () => {
        const result = await client.callTool({ name: 'fragile', arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe('fragile: formatted[no widgets left]');
      });

      it('reports an error no filter handles as a failed tool execution', async () => {
        const result = await client.callTool({ name: 'broken', arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe("Tool 'broken' execution failed: kaboom");
      });
    });

    describe('ordering', () => {
      it('runs built-in guards, middleware, then Nest guards, interceptors, pipes and the handler', async () => {
        const result = await client.callTool({ name: 'ordered', arguments: { name: 'ada' } });

        expect(textOf(result)).toBe('ok');
        expect(mcpTrace()).toEqual([
          'mcp-guard',
          'middleware:before',
          'app-guard:mcp:tool:ordered',
          'nest-guard',
          'interceptor:before',
          'pipe:body',
          'pipe:custom',
          'handler',
          'interceptor:after',
          'middleware:after',
        ]);
      });
    });

    describe('resources and prompts', () => {
      it('denies a resource read from a guard with the authorization error code', async () => {
        await expect(client.readResource({ uri: 'vault://secret' })).rejects.toMatchObject({
          code: MCP_AUTHORIZATION_ERROR,
        });
        expect(mcpTrace()).toEqual(['app-guard:mcp:resource:vault://secret']);
      });

      it('gives guards the URI template variables of a templated resource', async () => {
        const allowed = await client.readResource({ uri: 'users://1' });
        await expect(client.readResource({ uri: 'users://2' })).rejects.toMatchObject({
          code: MCP_AUTHORIZATION_ERROR,
        });

        expect(allowed.contents).toEqual([{ uri: 'users://1', text: 'user 1 at users://1' }]);
        expect(trace).toContain('own-user-guard:resource:users://1');
        expect(trace).toContain('own-user-guard:resource:users://2');
      });

      it('guards prompts on their arguments', async () => {
        const allowed = await client.getPrompt({ name: 'brief', arguments: { topic: 'weather' } });
        await expect(
          client.getPrompt({ name: 'brief', arguments: { topic: 'secret' } }),
        ).rejects.toMatchObject({ code: MCP_AUTHORIZATION_ERROR });

        expect(allowed.messages).toEqual([
          { role: 'user', content: { type: 'text', text: 'brief me on weather' } },
        ]);
        expect(trace).toContain('app-guard:mcp:prompt:brief');
      });
    });

    describe('request-scoped providers and enhancers', () => {
      it('runs enhancers around a request-scoped tool provider', async () => {
        const acme = await connectStreamable(server.baseUrl, { headers: { 'x-tenant': 'acme' } });
        const globex = await connectStreamable(server.baseUrl, {
          headers: { 'x-tenant': 'globex' },
        });
        try {
          const acmeResult = await acme.callTool({ name: 'whoami', arguments: {} });
          const globexResult = await globex.callTool({ name: 'whoami', arguments: {} });

          expect(textOf(acmeResult)).toBe('<whoami>tenant:acme</whoami>');
          expect(textOf(globexResult)).toBe('<whoami>tenant:globex</whoami>');
        } finally {
          await acme.close();
          await globex.close();
        }
      });

      it('resolves a request-scoped guard against the calling request', async () => {
        const blocked = await connectStreamable(server.baseUrl, {
          headers: { 'x-tenant': 'blocked' },
        });
        try {
          const result = await blocked.callTool({ name: 'whoami', arguments: {} });

          expect(result.isError).toBe(true);
          expect(textOf(result)).toBe('Forbidden resource');
        } finally {
          await blocked.close();
        }
      });

      it('resolves a request-scoped interceptor on a default-scoped provider', async () => {
        const acme = await connectStreamable(server.baseUrl, { headers: { 'x-tenant': 'acme' } });
        try {
          const result = await acme.callTool({ name: 'stamped', arguments: {} });

          expect(textOf(result)).toBe('document (stamped for acme)');
        } finally {
          await acme.close();
        }
      });
    });
  });

  describe.each([
    ['left unset', undefined],
    ['off', false],
  ] as const)('with nestEnhancers %s', (_label, nestEnhancers) => {
    let server: E2eApp;
    let client: Client;

    beforeAll(async () => {
      server = await createMcpApp(appMetadata(nestEnhancers));
      client = await connectStreamable(server.baseUrl);
    });

    afterAll(async () => {
      await client.close();
      await server.close();
    });

    it('does not invoke an app-level guard for tool calls', async () => {
      const result = await client.callTool({ name: 'guarded', arguments: { allow: true } });

      expect(textOf(result)).toBe('granted');
      // The guard is live — it ran for the HTTP request — but not for the tool.
      expect(trace).toContain('app-guard:http');
      expect(mcpTrace()).toEqual(['handler:guarded']);
    });

    it('ignores Nest guards, interceptors and pipes on capabilities', async () => {
      const denied = await client.callTool({ name: 'guarded', arguments: { allow: false } });
      const wrapped = await client.callTool({ name: 'wrapped', arguments: {} });
      const shout = await client.callTool({ name: 'shout', arguments: { name: 'ada' } });

      expect(textOf(denied)).toBe('granted');
      expect(textOf(wrapped)).toBe('payload');
      expect(textOf(shout)).toBe(`hello ada over ${McpTransportType.STREAMABLE_HTTP}`);
    });
  });

  describe('with a capability provider registered under a custom token', () => {
    @Injectable()
    class TokenTools {
      @Tool({ name: 'token-guarded', description: 'Guarded tool', parameters: z.object({}) })
      @UseGuards(DenyGuard)
      run() {
        return 'ran';
      }
    }

    it('refuses the call instead of dropping the guard Nest cannot resolve', async () => {
      const server = await createMcpApp({
        imports: [
          McpModule.forRoot({
            name: 'token-server',
            version: '1.0.0',
            transport: McpTransportType.STREAMABLE_HTTP,
            nestEnhancers: true,
          }),
        ],
        providers: [{ provide: 'TOKEN_TOOLS', useClass: TokenTools }],
      });
      const client = await connectStreamable(server.baseUrl);
      try {
        const result = await client.callTool({ name: 'token-guarded', arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('DenyGuard');
        expect(textOf(result)).toContain('not listed by class');
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe('with a request-scoped app-level guard', () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedAppGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    const metadata = (nestEnhancers: boolean): ModuleMetadata => ({
      imports: [
        McpModule.forRoot({
          name: 'scoped-guard-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          nestEnhancers,
        }),
      ],
      providers: [{ provide: APP_GUARD, useClass: ScopedAppGuard }],
    });

    it('refuses to start with nestEnhancers on, rather than skip the guard', async () => {
      await expect(createMcpApp(metadata(true))).rejects.toThrow(/request- or transient-scoped/);
    });

    it('starts normally with nestEnhancers off', async () => {
      const server = await createMcpApp(metadata(false));
      await server.close();
    });
  });
});
