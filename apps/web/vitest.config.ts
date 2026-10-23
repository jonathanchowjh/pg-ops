import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Unset, the saved databases are read from the developer's own
// ~/.pgops/databases.json. Set, the file must exist, so it is made empty here;
// a test that saves one points this at its own directory.
const SAVED = join(tmpdir(), 'pgops-web-tests', 'databases.json');
mkdirSync(join(tmpdir(), 'pgops-web-tests'), { recursive: true });
writeFileSync(SAVED, '[]\n');

/**
 * This app has its own vitest config rather than being a project defined in
 * the root one. It carries the jsdom environment, the React plugin and the
 * `@` alias that only this app needs. Vite resolves bare specifiers from the
 * config's directory, and the `@` alias is defined relative to this file, so
 * it only stays correct while the config sits beside the app.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // tsconfig `paths` are invisible to vitest, which resolves modules itself
    // rather than through tsc.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/**/*.int.test.ts'],
    env: { PGOPS_CONFIG_FILE: SAVED },
  },
});
