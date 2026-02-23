import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    '@btwld/mcp-common',
    '@btwld/mcp-server',
    '@btwld/mcp-client',
    '@modelcontextprotocol/sdk',
    /^@modelcontextprotocol\/sdk\//,
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    '@nestjs/platform-fastify',
    '@nestjs/testing',
    '@nestjs/microservices',
    '@nestjs/websockets',
    'rxjs',
    'reflect-metadata',
  ],
});
