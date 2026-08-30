import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Dockerfile builds from this. Standalone traces only the files actually
  // reached, so the runtime layer carries no build toolchain.
  output: 'standalone',

  // Explicit, not inferred. Next infers this root by walking up from apps/web
  // looking for a workspace marker or a lockfile (next/dist/lib/find-root.js),
  // and today it lands on this same repo root via the `workspaces` field in the
  // root package.json — so this setting changes nothing right now. It is here
  // because that inference depends on directory structure that can shift
  // silently: a nested package.json gaining its own `workspaces` field, a
  // lockfile appearing under apps/web, a worktree boundary moving. The
  // standalone output is rooted here, which is why server.js lands at
  // apps/web/server.js — and the Dockerfile's COPY and CMD paths are hard-coded
  // to exactly that layout. Pinning it makes that layout a contract instead of
  // a walk-up result.
  //
  // What this does NOT do, despite an earlier version of this comment saying so:
  // it does not keep packages/checks/dist in the output. That package's code is
  // bundled directly into the server chunk (verified: audit.ts's log strings
  // appear in .next/server/chunks/[root-of-the-server]__*.js, and nothing under
  // .next/server requires the '@pgops/checks' specifier), so there is no dist/
  // to omit and no module-not-found to prevent.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default config;
