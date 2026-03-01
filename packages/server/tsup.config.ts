import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    '@nest-mcp/common',
    '@modelcontextprotocol/sdk',
    /^@modelcontextprotocol\/sdk\/.*/,
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/testing',
    '@nestjs/microservices',
    '@nestjs/platform-express',
    'rxjs',
    'zod',
    'reflect-metadata',
    'express',
    'crypto',
  ],
});
