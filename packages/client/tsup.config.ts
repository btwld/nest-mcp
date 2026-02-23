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
    '@modelcontextprotocol/sdk',
    /^@modelcontextprotocol\/sdk\/.*/,
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/microservices',
    '@nestjs/testing',
    'rxjs',
    'reflect-metadata',
  ],
});
