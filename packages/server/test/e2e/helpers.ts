import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Module } from '@nestjs/common';
import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

export interface E2eApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Boot a real Nest app (Express) from module metadata on an ephemeral port. */
export async function createMcpApp(
  metadata: ModuleMetadata,
  configure?: (app: INestApplication) => void,
): Promise<E2eApp> {
  @Module(metadata)
  class E2eRootModule {}

  // bodyParser must stay off: the SDK transports read the raw request stream
  // themselves (same setup as every app under apps/).
  const app = await NestFactory.create(E2eRootModule, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  configure?.(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

export interface ConnectOptions {
  endpoint?: string;
  headers?: Record<string, string>;
}

/** Connect a real SDK client over streamable HTTP. */
export async function connectStreamable(
  baseUrl: string,
  options: ConnectOptions = {},
): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}${options.endpoint ?? '/mcp'}`),
    options.headers ? { requestInit: { headers: options.headers } } : undefined,
  );
  await client.connect(transport);
  return client;
}

/** Connect a real SDK client over the legacy HTTP+SSE transport. */
export async function connectSse(baseUrl: string, endpoint = '/sse'): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(new SSEClientTransport(new URL(`${baseUrl}${endpoint}`)));
  return client;
}

/** Poll until `predicate` returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(
  predicate: () => T | undefined | false,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
