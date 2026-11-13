import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = Object.fromEntries(
  ['protocol', 'postgres', 'evidence', 'scenario', 'runner', 'oracle', 'core', 'shrinker', 'report'].map((name) => [
    `@rollprobe/${name}`,
    path.resolve(process.cwd(), `packages/${name}/src/index.ts`),
  ])
);

export default defineConfig({
  cacheDir: './node_modules/.vitest-cache',
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
});
