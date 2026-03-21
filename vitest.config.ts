import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'bridge/src/__tests__/**/*.test.ts',
      'hooks/src/__tests__/**/*.test.ts',
      'shared/src/__tests__/**/*.test.ts',
      'plugin/src/__tests__/**/*.test.ts',
    ],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
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
    },
  },
});
