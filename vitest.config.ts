import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'bridge/src/__tests__/**/*.test.ts',
      'hooks/src/__tests__/**/*.test.ts',
      'shared/src/__tests__/**/*.test.ts',
    ],
    testTimeout: 10_000,
  },
});
