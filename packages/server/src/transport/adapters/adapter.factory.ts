import { Logger } from '@nestjs/common';
import type { McpHttpAdapter, HttpAdapterType } from '@btwld/mcp-common';
import { ExpressAdapter } from './express.adapter';
import { FastifyAdapter } from './fastify.adapter';

const logger = new Logger('HttpAdapterFactory');
let cachedAdapter: McpHttpAdapter | null = null;
let cachedType: HttpAdapterType | null = null;

export function getHttpAdapter(request: any): McpHttpAdapter {
  const type = detectAdapterType(request);
  if (cachedAdapter && cachedType === type) return cachedAdapter;

  cachedType = type;
  cachedAdapter = type === 'fastify' ? new FastifyAdapter() : new ExpressAdapter();
  logger.log(`Detected HTTP adapter: ${type}`);
  return cachedAdapter;
}

function detectAdapterType(request: any): HttpAdapterType {
  if (request?.routeOptions || request?.routerPath) {
    return 'fastify';
  }
  return 'express';
}
