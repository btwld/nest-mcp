import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild (vitest's default transform) does not emit `design:paramtypes`,
  // which real NestJS DI needs. The e2e suite boots real Nest apps, so
  // transform with SWC and decorator metadata enabled instead.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.spec.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
