import 'reflect-metadata';
import { McpRegistryService } from '@nest-mcp/server';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { petstoreMini } from '../../test/fixtures/petstore-mini';
import { OpenApiMcpModule, OpenApiMcpService } from './openapi-mcp.module';

@Global()
@Module({ providers: [McpRegistryService], exports: [McpRegistryService] })
class HostModule {}

describe('OpenApiMcpModule', () => {
  it('registers all operations as tools tagged with the source name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HostModule,
        OpenApiMcpModule.forRoot({
          name: 'petstore',
          document: petstoreMini,
          baseUrl: 'https://api.example.com',
        }),
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const registry = moduleRef.get(McpRegistryService);
    const tools = registry.getToolsBySource('openapi:petstore');
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'petstore.createPet',
      'petstore.deletePet',
      'petstore.getPetById',
      'petstore.listPets',
    ]);

    const service = moduleRef.get(OpenApiMcpService);
    expect(service.getSourceCount()).toBe(1);

    await app.close();
  });

  it('rejects multiple sources without unique names', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          HostModule,
          OpenApiMcpModule.forRoot({
            sources: [
              { document: petstoreMini, baseUrl: 'https://x' },
              { document: petstoreMini, baseUrl: 'https://y' },
            ],
          }),
        ],
      })
        .compile()
        .then((m) => m.createNestApplication().init()),
    ).rejects.toThrow(/every source must have a `name`/);
  });
});
