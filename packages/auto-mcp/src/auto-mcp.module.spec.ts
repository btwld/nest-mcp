import 'reflect-metadata';
import { McpRegistryService } from '@nest-mcp/server';
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { RouteScannerService } from './discovery/route-scanner.service';
import { PipelineExecutorService } from './execution/pipeline-executor.service';
import { RouteRegistrarService } from './registration/route-registrar.service';

class UserDto {
  name!: string;
}

@Controller('users')
class UsersController {
  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  create(@Body() body: UserDto): { name: string } {
    return { name: body.name };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

/**
 * Module-flow tests bypass NestJS lifecycle: we resolve `ModulesContainer`
 * via `app.init()` (so controllers are wrapped) and then drive the registrar
 * by hand against a fresh `McpRegistryService`. This isolates the auto-mcp
 * registration logic from any host-app DI shape.
 */
describe('AutoMcpModule', () => {
  async function bootContainer(): Promise<ModulesContainer> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app.get(ModulesContainer);
  }

  it('registers every UsersController route as an MCP tool with default namespace', async () => {
    const container = await bootContainer();
    const registry = new McpRegistryService();
    const scanner = new RouteScannerService(container);
    const executor = new PipelineExecutorService(
      container,
      // Minimal moduleRef stub — only used at invoke-time which isn't exercised here
      { get: () => undefined } as never,
    );
    const registrar = new RouteRegistrarService({}, scanner, executor, registry);

    registrar.onApplicationBootstrap();

    const tools = registry.getToolsBySource('nestjs');
    expect(tools.map((t) => t.name).sort()).toEqual([
      'nestjs.users.create',
      'nestjs.users.findOne',
    ]);
  });

  it('emits flat names when namespace=false', async () => {
    const container = await bootContainer();
    const registry = new McpRegistryService();
    const scanner = new RouteScannerService(container);
    const executor = new PipelineExecutorService(container, { get: () => undefined } as never);
    const registrar = new RouteRegistrarService({ namespace: false }, scanner, executor, registry);

    registrar.onApplicationBootstrap();

    expect(
      registry
        .getToolsBySource('nestjs')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['users.create', 'users.findOne']);
  });

  it('skips every route when mode=opt-in and no @McpExpose decorator is present', async () => {
    const container = await bootContainer();
    const registry = new McpRegistryService();
    const scanner = new RouteScannerService(container);
    const executor = new PipelineExecutorService(container, { get: () => undefined } as never);
    const registrar = new RouteRegistrarService({ mode: 'opt-in' }, scanner, executor, registry);

    registrar.onApplicationBootstrap();

    expect(registry.getToolsBySource('nestjs')).toHaveLength(0);
  });
});
