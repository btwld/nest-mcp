import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { ToolCallResult, ResourceReadResult, PromptGetResult } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import { McpRegistryService } from '../discovery/registry.service';
import { McpExecutorService } from '../execution/executor.service';
import { McpContextFactory } from '../execution/context.factory';

export interface McpTestApp {
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  readResource(uri: string): Promise<ResourceReadResult>;
  listTools(): Promise<Array<Record<string, unknown>>>;
  listResources(): Promise<Array<Record<string, unknown>>>;
  listPrompts(): Promise<Array<Record<string, unknown>>>;
  getPrompt(name: string, args?: Record<string, unknown>): Promise<PromptGetResult>;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  providers: any[];
  imports?: any[];
}

export async function createMcpTestApp(options: CreateTestAppOptions): Promise<McpTestApp> {
  const moduleBuilder = Test.createTestingModule({
    imports: options.imports ?? [],
    providers: [
      McpRegistryService,
      McpExecutorService,
      McpContextFactory,
      ...options.providers,
    ],
  });

  const moduleRef: TestingModule = await moduleBuilder.compile();
  await moduleRef.init();

  const registry = moduleRef.get(McpRegistryService);
  const executor = moduleRef.get(McpExecutorService);
  const contextFactory = moduleRef.get(McpContextFactory);

  // Scan all providers
  for (const provider of options.providers) {
    try {
      const instance = moduleRef.get(provider);
      if (instance) registry.registerProvider(instance);
    } catch {
      // Skip non-injectable providers
    }
  }

  const ctx = contextFactory.createContext({
    sessionId: 'test',
    transport: McpTransportType.STDIO,
  });

  return {
    async callTool(name: string, args: Record<string, unknown> = {}) {
      return executor.callTool(name, args, ctx);
    },
    async readResource(uri: string) {
      return executor.readResource(uri, ctx);
    },
    async listTools() {
      return executor.listTools();
    },
    async listResources() {
      return executor.listResources();
    },
    async listPrompts() {
      return executor.listPrompts();
    },
    async getPrompt(name: string, args: Record<string, unknown> = {}) {
      return executor.getPrompt(name, args, ctx);
    },
    async close() {
      await moduleRef.close();
    },
  };
}
