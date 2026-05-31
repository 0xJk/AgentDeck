import { defineConfig } from 'vitest/config';

// Pin the timezone for the whole suite so time-formatting snapshots (e.g. the
// timeline renderer's `new Date(ts).getHours()`) render deterministically on
// every machine and in CI. The committed snapshots were recorded in Asia/Seoul.
// Set here in the parent process before any worker forks so each worker inherits
// a stable TZ at ICU init — a per-test-file `process.env.TZ` is unreliable
// because Node caches the zone once an earlier file touches Date.
process.env.TZ = process.env.TZ ?? 'Asia/Seoul';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'bridge/src/__tests__/**/*.test.ts',
      'hooks/src/__tests__/**/*.test.ts',
      'shared/src/__tests__/**/*.test.ts',
      'plugin/src/__tests__/**/*.test.ts',
    ],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        'bridge/src/**/*.ts',
        'shared/src/**/*.ts',
        'plugin/src/**/*.ts',
        'hooks/src/**/*.ts',
      ],
      exclude: [
        '**/__tests__/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
      thresholds: {
        // Regression guard — set slightly below current levels.
        // Raise these as coverage improves.
        lines: 17,
        functions: 15,
        branches: 14,
        statements: 16,
      },
    },
  },
});
