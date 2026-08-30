import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * This app has its own vitest config rather than being a project defined in
 * the root one. Read the history first, because it is why this file exists
 * at all: the repo root used to carry react 18 for the Ink TUI while this
 * app ran react 19, and Vite resolves bare specifiers from the CONFIG's
 * directory. Configured at the root, `react-dom` resolved to the app's 19
 * while `react/jsx-runtime` resolved to the root's 18, and every render
 * failed with "Objects are not valid as a React child" — an error that names
 * neither react nor a version. Rooted here, all three resolved from
 * apps/web/node_modules together.
 *
 * P1b deleted the TUI, so that hazard is now historical: one react major is
 * left, and it hoists to the repo root rather than nesting here. The file
 * stays anyway, and not out of inertia — it carries the jsdom environment,
 * the React plugin and the `@` alias that only this app needs, none of which
 * belong in a config shared with a node-environment package suite. Folding
 * it in would trade a real file for a nested block and re-open the
 * resolution question above, which took three failed attempts to close. The
 * `@` alias in particular is defined relative to THIS file's directory; it
 * is the app's own tsconfig path mapping, which vitest does not read, and it
 * only stays correct while the config sits beside the app it maps.
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
  },
});
