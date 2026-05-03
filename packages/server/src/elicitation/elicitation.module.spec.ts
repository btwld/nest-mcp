import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { McpElicitationModule } from './elicitation.module';
import {
  ELICITATION_MODULE_OPTIONS,
  type ResolvedElicitationOptions,
} from './interfaces/elicitation-options.interface';
import {
  ELICITATION_STORE_TOKEN,
  type IElicitationStore,
} from './interfaces/elicitation-store.interface';
import type {
  ElicitationRecord,
  ElicitationResultRecord,
} from './interfaces/elicitation.interface';
import { ElicitationService } from './services/elicitation.service';
import { MemoryElicitationStore } from './stores/memory-elicitation.store';

class FakeStore implements IElicitationStore {
  async storeElicitation(_record: ElicitationRecord): Promise<void> {}
  async getElicitation(_id: string): Promise<ElicitationRecord | undefined> {
    return undefined;
  }
  async updateElicitation(_id: string, _updates: Partial<ElicitationRecord>): Promise<void> {}
  async storeResult(_result: ElicitationResultRecord): Promise<void> {}
  async getResult(_id: string): Promise<ElicitationResultRecord | undefined> {
    return undefined;
  }
  async findResultByUserAndType(
    _userId: string,
    _type: string,
  ): Promise<ElicitationResultRecord | undefined> {
    return undefined;
  }
  async removeElicitation(_id: string): Promise<void> {}
  async getElicitationsBySession(_sessionId: string): Promise<ElicitationRecord[]> {
    return [];
  }
  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

const SERVER_URL_TOKEN = 'TEST_SERVER_URL';

@Injectable()
class FakeConfigService {
  readonly serverUrl = 'https://injected.example.com';
}

@Module({
  providers: [FakeConfigService],
  exports: [FakeConfigService],
})
class FakeConfigModule {}

const compile = async (mod: ReturnType<typeof McpElicitationModule.forRoot>) => {
  const ref = await Test.createTestingModule({ imports: [mod] }).compile();
  await ref.init();
  return ref;
};

describe('McpElicitationModule', () => {
  describe('forRoot', () => {
    it('resolves ElicitationService and merges defaults onto serverUrl', async () => {
      const ref = await compile(
        McpElicitationModule.forRoot({ serverUrl: 'https://api.example.com' }),
      );

      const service = ref.get(ElicitationService);
      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);

      expect(service).toBeInstanceOf(ElicitationService);
      expect(opts.serverUrl).toBe('https://api.example.com');
      expect(opts.apiPrefix).toBe('elicitation');

      await ref.close();
    });

    it('falls back to MemoryElicitationStore when no storeConfiguration is supplied', async () => {
      const ref = await compile(
        McpElicitationModule.forRoot({ serverUrl: 'https://api.example.com' }),
      );

      const store = ref.get<IElicitationStore>(ELICITATION_STORE_TOKEN);
      expect(store).toBeInstanceOf(MemoryElicitationStore);

      await ref.close();
    });

    it('uses the user-supplied custom store when storeConfiguration.type is "custom"', async () => {
      const customStore = new FakeStore();
      const ref = await compile(
        McpElicitationModule.forRoot({
          serverUrl: 'https://api.example.com',
          storeConfiguration: { type: 'custom', store: customStore },
        }),
      );

      const store = ref.get<IElicitationStore>(ELICITATION_STORE_TOKEN);
      expect(store).toBe(customStore);

      await ref.close();
    });
  });

  describe('forRootAsync', () => {
    it('resolves options from a synchronous useFactory', async () => {
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          useFactory: () => ({ serverUrl: 'https://sync.example.com' }),
        }),
      );

      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);
      expect(opts.serverUrl).toBe('https://sync.example.com');
      expect(opts.apiPrefix).toBe('elicitation');
      expect(ref.get(ElicitationService)).toBeInstanceOf(ElicitationService);

      await ref.close();
    });

    it('resolves options from a promise-returning useFactory', async () => {
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          useFactory: async () => {
            await Promise.resolve();
            return { serverUrl: 'https://async.example.com', elicitationTtlMs: 1_234 };
          },
        }),
      );

      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);
      expect(opts.serverUrl).toBe('https://async.example.com');
      expect(opts.elicitationTtlMs).toBe(1_234);

      await ref.close();
    });

    it('passes injected dependencies through to the useFactory', async () => {
      @Module({
        providers: [{ provide: SERVER_URL_TOKEN, useValue: 'https://token.example.com' }],
        exports: [SERVER_URL_TOKEN],
      })
      class ServerUrlModule {}

      const ref = await Test.createTestingModule({
        imports: [
          McpElicitationModule.forRootAsync({
            imports: [ServerUrlModule],
            inject: [SERVER_URL_TOKEN],
            useFactory: (serverUrl: string) => ({ serverUrl }),
          }),
        ],
      }).compile();
      await ref.init();

      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);
      expect(opts.serverUrl).toBe('https://token.example.com');

      await ref.close();
    });

    it('honors imports + inject from an external module', async () => {
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfigService],
          useFactory: (config: FakeConfigService) => ({ serverUrl: config.serverUrl }),
        }),
      );

      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);
      expect(opts.serverUrl).toBe('https://injected.example.com');

      await ref.close();
    });

    it('uses MemoryElicitationStore when the factory returns no storeConfiguration', async () => {
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          useFactory: () => ({ serverUrl: 'https://api.example.com' }),
        }),
      );

      const store = ref.get<IElicitationStore>(ELICITATION_STORE_TOKEN);
      expect(store).toBeInstanceOf(MemoryElicitationStore);

      await ref.close();
    });

    it('uses the custom store when the factory returns storeConfiguration.type "custom"', async () => {
      const customStore = new FakeStore();
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          useFactory: () => ({
            serverUrl: 'https://api.example.com',
            storeConfiguration: { type: 'custom', store: customStore },
          }),
        }),
      );

      const store = ref.get<IElicitationStore>(ELICITATION_STORE_TOKEN);
      expect(store).toBe(customStore);

      await ref.close();
    });

    it('keeps apiPrefix on the sync wrapper rather than the factory result', async () => {
      const ref = await compile(
        McpElicitationModule.forRootAsync({
          apiPrefix: 'custom-prefix',
          useFactory: () => ({ serverUrl: 'https://api.example.com' }),
        }),
      );

      const opts = ref.get<ResolvedElicitationOptions>(ELICITATION_MODULE_OPTIONS);
      expect(opts.apiPrefix).toBe('custom-prefix');

      await ref.close();
    });
  });
});
