import type { HttpAdapterType, McpHttpAdapter } from '@btwld/mcp-common';
import { Logger } from '@nestjs/common';
import { ExpressAdapter } from './express.adapter';
import { FastifyAdapter } from './fastify.adapter';

const logger = new Logger('HttpAdapterFactory');
let cachedAdapter: McpHttpAdapter | null = null;
let cachedType: HttpAdapterType | null = null;

export function getHttpAdapter(request: unknown): McpHttpAdapter {
  const type = detectAdapterType(request);
  if (cachedAdapter && cachedType === type) return cachedAdapter;

  cachedType = type;
  cachedAdapter = type === 'fastify' ? new FastifyAdapter() : new ExpressAdapter();
  logger.log(`Detected HTTP adapter: ${type}`);
  return cachedAdapter;
}

function detectAdapterType(request: unknown): HttpAdapterType {
  const req = request as Record<string, unknown> | null | undefined;
  if (req?.routeOptions || req?.routerPath) {
    return 'fastify';
  }
  return 'express';
}
