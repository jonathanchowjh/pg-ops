/**
 * Configuration is read from the environment AT REQUEST TIME, never at module
 * scope. Every caller passes `process.env` in explicitly, which is what makes
 * this file pure and exhaustively testable — and, more importantly, what stops
 * a module-scope read from being evaluated during `next build` and baked into
 * the image. See the plan's Global Constraints on `connection()`.
 */

import { readFileSync } from 'node:fs';

/**
 * What pgops calls itself in `pg_stat_activity.application_name`.
 *
 * Lives in config.ts, which imports nothing local, because both sides of the
 * name need it and they already form a cycle: pools.ts imports `storePool`
 * from store.ts, so store.ts importing back from pools.ts made
 * `pools -> store -> pools`. Under ESM that is not a warning — a `const` in a
 * cycle is in its temporal dead zone while the other module initialises, so
 * whichever side loaded second would read APP_NAME as undefined and name its
 * connections "undefined-store", at runtime, only in whichever import order
 * the bundler happened to pick.
 *
 * One definition, deliberately: the pool that SETS this string and the view
 * that HIDES it must agree, and two copies of a literal is exactly how that
 * stops being true.
 */
export const APP_NAME = 'pgops';


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
  // Precedence: a mounted file is the most deliberate of the three acts, and
  // it is also the only one that keeps connection strings out of the process
  // environment (visible to `docker inspect` and to anything that can read
  // /proc/<pid>/environ). See the plan's Ruling 1 for this task.
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
 * Read synchronously, on every request, deliberately — see the plan's Ruling 2.
 * `readDatabases` is called from `contextFor` on the render path of every page;
 * making it async would push `await` through `databaseNames()` and every Server
 * Component that lists databases, to save a page-cached read of a local file.
 *
 * The error names the PATH, not just the variable. An operator debugging a
 * Kubernetes deployment needs to know pgops looked at
 * /etc/pgops/databases.json and found nothing — "PGOPS_CONFIG_FILE could not
 * be read" sends them to check the variable, which is set correctly.
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
// JSON came from, so every message below points an operator at the input
// they actually set instead of always naming the environment variable.
function parseMany(raw: string, source: string): DatabaseConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A raw SyntaxError here reads as a bug in pgops rather than a typo in the
    // operator's own deployment configuration, which is what it actually is.
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
