import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Dockerfile builds from this. Standalone traces only the files actually
  // reached, so the runtime layer carries no build toolchain.
  output: 'standalone',

  // Explicit, not inferred. Next would infer this same root by walking up to
  // a workspace marker or a lockfile, which can shift silently. The standalone
  // output is rooted here, which is why server.js lands at apps/web/server.js,
  // and the Dockerfile's COPY and CMD paths are hard-coded to that layout.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default config;
