import type { HttpAdapterType, McpHttpAdapter } from '@nest-mcp/common';
import { Logger } from '@nestjs/common';
import { ExpressAdapter } from './express.adapter';
import { FastifyAdapter } from './fastify.adapter';

const logger = new Logger('HttpAdapterFactory');
const adapterCache = new Map<HttpAdapterType, McpHttpAdapter>();

export function getHttpAdapter(request: unknown): McpHttpAdapter {
  const type = detectAdapterType(request);
  const cached = adapterCache.get(type);
  if (cached) return cached;
  const adapter = type === 'fastify' ? new FastifyAdapter() : new ExpressAdapter();
  adapterCache.set(type, adapter);
  logger.log(`Detected HTTP adapter: ${type}`);
  return adapter;
}

function detectAdapterType(request: unknown): HttpAdapterType {
  const req = request as Record<string, unknown> | null | undefined;
  if (req?.routeOptions || req?.routerPath) {
    return 'fastify';
  }
  return 'express';
}
