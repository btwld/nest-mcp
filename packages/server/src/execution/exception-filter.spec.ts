import 'reflect-metadata';
import { McpError, McpTransportType, ToolExecutionError } from '@nest-mcp/common';
import type { McpModuleOptions } from '@nest-mcp/common';
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  UseFilters,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

const defaultOptions: McpModuleOptions = {
  name: 'test',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
};

class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

@Catch(DomainError)
class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, _host: ArgumentsHost) {
    return `domain: ${error.message}`;
  }
}

@Catch()
class CatchAllFilter implements ExceptionFilter {
  catch(error: Error, _host: ArgumentsHost) {
    return { handled: true, msg: error.message };
  }
}

@Catch(HttpException)
class HttpFilter implements ExceptionFilter {
  catch(error: HttpException, _host: ArgumentsHost) {
    return `http:${error.getStatus()}:${error.message}`;
  }
}

const makeExecutor = (registry: McpRegistryService) =>
  new McpExecutorService(registry, new McpExceptionFilterRunner(new Reflector()), defaultOptions);

describe('Exception filter integration', () => {
  function registerToolFromClass<T extends abstract new (...args: never[]) => object>(
    registry: McpRegistryService,
    target: T,
    methodName: string,
    instance: InstanceType<T>,
  ): void {
    registry.registerTool({
      name: methodName,
      description: methodName,
      methodName,
      target,
      instance,
    } as RegisteredTool);
  }

  describe('callTool', () => {
    it('routes a thrown exception through a method-level filter', async () => {
      class Tools {
        @UseFilters(DomainExceptionFilter)
        async fail(_args: unknown) {
          throw new DomainError('boom');
        }
      }

      const registry = new McpRegistryService();
      registerToolFromClass(registry, Tools, 'fail', new Tools());

      const executor = makeExecutor(registry);
      await expect(executor.callTool('fail', {}, mockMcpContext())).rejects.toMatchObject({
        message: 'domain: boom',
      });
    });

    it('routes through a class-level filter when method-level is absent', async () => {
      @UseFilters(CatchAllFilter)
      class Tools {
        async fail() {
          throw new Error('plain');
        }
      }

      const registry = new McpRegistryService();
      registerToolFromClass(registry, Tools, 'fail', new Tools());

      const executor = makeExecutor(registry);
      await expect(executor.callTool('fail', {}, mockMcpContext())).rejects.toMatchObject({
        message: '{"handled":true,"msg":"plain"}',
      });
    });

    it('skips non-matching @Catch(SpecificError) filters', async () => {
      class Tools {
        @UseFilters(DomainExceptionFilter)
        async fail() {
          throw new Error('plain');
        }
      }

      const registry = new McpRegistryService();
      registerToolFromClass(registry, Tools, 'fail', new Tools());

      const executor = makeExecutor(registry);
      await expect(executor.callTool('fail', {}, mockMcpContext())).rejects.toBeInstanceOf(
        ToolExecutionError,
      );
    });

    it('falls through to ToolExecutionError when no filter is declared', async () => {
      class Tools {
        async fail() {
          throw new Error('plain');
        }
      }

      const registry = new McpRegistryService();
      registerToolFromClass(registry, Tools, 'fail', new Tools());

      const executor = makeExecutor(registry);
      await expect(executor.callTool('fail', {}, mockMcpContext())).rejects.toBeInstanceOf(
        ToolExecutionError,
      );
    });

    it('does not run filter for McpError subclasses (protocol-level)', async () => {
      class Tools {
        @UseFilters(CatchAllFilter)
        async fail() {
          throw new ToolExecutionError('fail', 'already wrapped');
        }
      }

      const registry = new McpRegistryService();
      registerToolFromClass(registry, Tools, 'fail', new Tools());

      const executor = makeExecutor(registry);
      const err = await executor.callTool('fail', {}, mockMcpContext()).catch((e) => e);
      expect(err).toBeInstanceOf(ToolExecutionError);
    });
  });

  describe('readResource', () => {
    it('routes a resource handler error through a class-level filter', async () => {
      @UseFilters(HttpFilter)
      class Resources {
        readConfig() {
          throw new BadRequestException('missing key');
        }
      }

      const registry = new McpRegistryService();
      registry.registerResource({
        uri: 'cfg://test',
        name: 'cfg',
        methodName: 'readConfig',
        target: Resources,
        instance: new Resources(),
      } as RegisteredResource);

      const executor = makeExecutor(registry);
      await expect(executor.readResource('cfg://test', mockMcpContext())).rejects.toMatchObject({
        message: 'http:400:missing key',
      });
    });

    it('routes a template handler error through a method-level filter', async () => {
      class Templates {
        @UseFilters(DomainExceptionFilter)
        readUser(_url: URL, _params: Record<string, string>) {
          throw new DomainError('not found');
        }
      }

      const registry = new McpRegistryService();
      registry.registerResourceTemplate({
        uriTemplate: 'users://{id}',
        name: 'user',
        methodName: 'readUser',
        target: Templates,
        instance: new Templates(),
      } as RegisteredResourceTemplate);

      const executor = makeExecutor(registry);
      await expect(executor.readResource('users://42', mockMcpContext())).rejects.toMatchObject({
        message: 'domain: not found',
      });
    });
  });

  describe('getPrompt', () => {
    it('routes a prompt handler error through a filter', async () => {
      class Prompts {
        @UseFilters(DomainExceptionFilter)
        async get() {
          throw new DomainError('bad prompt');
        }
      }

      const registry = new McpRegistryService();
      registry.registerPrompt({
        name: 'p',
        description: 'p',
        methodName: 'get',
        target: Prompts,
        instance: new Prompts(),
      } as RegisteredPrompt);

      const executor = makeExecutor(registry);
      await expect(executor.getPrompt('p', {}, mockMcpContext())).rejects.toMatchObject({
        message: 'domain: bad prompt',
      });
    });
  });

  it('rendered McpError carries a non-empty message', async () => {
    class Tools {
      @UseFilters(DomainExceptionFilter)
      async fail() {
        throw new DomainError('boom');
      }
    }

    const registry = new McpRegistryService();
    registerToolFromClass(registry, Tools, 'fail', new Tools());

    const executor = makeExecutor(registry);
    const err = await executor.callTool('fail', {}, mockMcpContext()).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toBe('domain: boom');
  });
});
