import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/common',
  'packages/server',
  'packages/client',
  'packages/gateway',
]);
