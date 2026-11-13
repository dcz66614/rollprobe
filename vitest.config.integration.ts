import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = Object.fromEntries(
  ['protocol', 'postgres', 'evidence', 'scenario', 'runner', 'oracle', 'core', 'shrinker', 'report'].map((name) => [
    `@rollprobe/${name}`,
    path.resolve(process.cwd(), `packages/${name}/src/index.ts`),
  ])
);

/**
 * Integration tests need a reachable Docker engine and the real PostgreSQL 17 image.
 * They are never skipped silently: `tests/integration/setup.ts` fails the run with a clear
 * message when the engine is missing.
 */
export default defineConfig({
  cacheDir: './node_modules/.vitest-cache',
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});
