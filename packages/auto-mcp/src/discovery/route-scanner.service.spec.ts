import 'reflect-metadata';
import { Body, Controller, Delete, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { McpExpose, McpHide } from '../decorators';
import { RouteScannerService } from './route-scanner.service';

class CreateUserDto {
  name!: string;
  email!: string;
}

@Controller('users')
class UsersController {
  @Get()
  list(@Query('limit') _limit: number): unknown[] {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') _id: string): unknown {
    return {};
  }

  @Post()
  create(@Body() _body: CreateUserDto): unknown {
    return {};
  }

  @McpHide()
  @Delete(':id')
  remove(@Param('id') _id: string): void {
    // intentionally hidden
  }
}

@Controller('admin')
class AdminController {
  @McpExpose({ name: 'admin.ping', description: 'Ping the admin endpoint' })
  @Get('ping')
  ping(): string {
    return 'pong';
  }
}

@Module({ controllers: [UsersController, AdminController] })
class AppModule {}

describe('RouteScannerService', () => {
  it('discovers every controller route except @McpHide', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const scanner = new RouteScannerService(app.get(ModulesContainer));
    const routes = scanner.scan({});
    const keys = routes.map((r) => `${r.controllerName}.${r.methodName}`).sort();
    expect(keys).toEqual([
      'AdminController.ping',
      'UsersController.create',
      'UsersController.findOne',
      'UsersController.list',
    ]);
  });

  it('respects mode: opt-in', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const scanner = new RouteScannerService(app.get(ModulesContainer));
    const routes = scanner.scan({ mode: 'opt-in' });
    expect(routes.map((r) => `${r.controllerName}.${r.methodName}`)).toEqual([
      'AdminController.ping',
    ]);
  });

  it('decodes path/query/body params from ROUTE_ARGS_METADATA', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const scanner = new RouteScannerService(app.get(ModulesContainer));
    const routes = scanner.scan({});
    const findOne = routes.find((r) => r.methodName === 'findOne');
    if (!findOne) throw new Error('expected findOne route');
    expect(findOne.params).toHaveLength(1);
    expect(findOne.params[0]).toMatchObject({ kind: 'param', data: 'id' });

    const list = routes.find((r) => r.methodName === 'list');
    if (!list) throw new Error('expected list route');
    expect(list.params[0]).toMatchObject({ kind: 'query', data: 'limit' });

    const create = routes.find((r) => r.methodName === 'create');
    if (!create) throw new Error('expected create route');
    expect(create.params[0]).toMatchObject({ kind: 'body', data: undefined });
  });

  it('honors include/exclude matchers', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const scanner = new RouteScannerService(app.get(ModulesContainer));
    const onlyAdmin = scanner.scan({ include: [/^Admin/] });
    expect(onlyAdmin.map((r) => r.controllerName)).toEqual(['AdminController']);

    const noUsers = scanner.scan({ exclude: [{ controller: UsersController }] });
    expect(noUsers.map((r) => r.controllerName)).toEqual(['AdminController']);
  });

  it('reports the full url path (controller prefix + route path)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const scanner = new RouteScannerService(app.get(ModulesContainer));
    const routes = scanner.scan({});
    const findOne = routes.find((r) => r.methodName === 'findOne');
    expect(findOne?.fullPath).toBe('/users/:id');
  });
});
