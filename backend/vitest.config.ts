import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Borra las credenciales reales del .env antes de cada archivo de test.
    setupFiles: ['tests/setup/no-real-credentials.ts'],
    globals: false,
    pool: 'forks',
    testTimeout: 10_000,
  },
});
