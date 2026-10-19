/**
 * Every environment variable the web app reads is read in this file, except
 * the basic-auth pair, which lib/auth.ts checks against the request it guards.
 *
 * Configuration is read from the environment at request time, never at module
 * scope: every caller passes `process.env` in explicitly. A module-scope read
 * would be evaluated during `next build` and frozen into the image.
 */

import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface DatabaseConfig {
  /** URL path segment under /db/. Unique. */
  name: string;
  url: string;
}

/** Path-segment safe: no slashes, no encoding surprises, no empty string. */
const NAME = /^[A-Za-z0-9_-]+$/;

export function readDatabases(env: Record<string, string | undefined>): DatabaseConfig[] {
  // Precedence: a mounted file is the most deliberate of the three, and the
  // only one that keeps connection strings out of the process environment
  // (visible to `docker inspect` and to anything that can read
  // /proc/<pid>/environ).
  const file = env.PGOPS_CONFIG_FILE;
  if (file) return parseMany(readConfigFile(file), `PGOPS_CONFIG_FILE (${file})`);

  const many = env.PGOPS_DATABASES;
  if (many) return parseMany(many, 'PGOPS_DATABASES');

  const one = env.DATABASE_URL;
  if (one) return [{ name: 'default', url: one }];

  throw new ConfigError(
    'No database configured. Set DATABASE_URL for one database, PGOPS_DATABASES ' +
    'to a JSON array of {name, url} for several, or PGOPS_CONFIG_FILE to a file ' +
    'holding that same array.',
  );
}

/**
 * Read synchronously, on every request, deliberately. `readDatabases` is
 * called from `contextFor` on the render path of every page; making it async
 * would push `await` through `databaseNames()` and every Server Component
 * that lists databases.
 *
 * The error names the path, not just the variable.
 */
function readConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `PGOPS_CONFIG_FILE points at ${path}, which could not be read: ${(err as Error).message}`,
    );
  }
}

// `source` names whichever of PGOPS_CONFIG_FILE or PGOPS_DATABASES the raw
// JSON came from, so every message below points at the input the operator
// set.
function parseMany(raw: string, source: string): DatabaseConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A raw SyntaxError would read as a bug in pgops rather than a typo in
    // the operator's configuration.
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError(`${source} must be a non-empty JSON array of {name, url}.`);
  }

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`${source}[${i}] is not an object.`);
    }
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new ConfigError(
        `${source}[${i}].name must match ${NAME.source} — it becomes a URL path segment.`,
      );
    }
    if (typeof url !== 'string' || url === '') {
      throw new ConfigError(`${source}[${i}].url must be a non-empty connection string.`);
    }
    if (seen.has(name)) throw new ConfigError(`${source} has a duplicate name: ${name}`);
    seen.add(name);
    return { name, url };
  });
}

/**
 * The store is opt-in, and deliberately has no fallback to a monitored
 * database: a fallback would have pgops issue CREATE SCHEMA against a
 * database the operator expected to be read only.
 */
export function storeUrl(env: Record<string, string | undefined>): string | null {
  const url = env.PGOPS_STORE_URL;
  // Unset and empty both mean "no store". A `Pool` built on an empty
  // connection string fails at connect time, far from its cause.
  if (url === undefined || url === '') return null;
  return url;
}

/**
 * The tier-1 gate. Actions are off unless this is "true"; with it unset the
 * action routes answer 404. Compared against the one documented value rather
 * than tested for truthiness, which would read the string "false" as on.
 */
export function actionsAllowed(env: Record<string, string | undefined>): boolean {
  return (env.PGOPS_ALLOW_ACTIONS ?? '').trim().toLowerCase() === 'true';
}

/**
 * The host name recorded in audit records, when the operator has set one.
 * Unset, the caller falls back to the request's own Host header.
 */
export function publicHost(env: Record<string, string | undefined>): string | undefined {
  return env.PGOPS_PUBLIC_HOST;
}
