/**
 * Every environment variable the web app reads is read in this file, except
 * the basic-auth pair, which lib/auth.ts checks against the request it guards.
 *
 * Configuration is read from the environment at request time, never at module
 * scope: every caller passes `process.env` in explicitly. A module-scope read
 * would be evaluated during `next build` and frozen into the image.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  /** `env` is the deployment's and is changed there; `saved` was added in the console and can be removed there. */
  source: 'env' | 'saved';
}

/** Path-segment safe: no slashes, no encoding surprises, no empty string. */
const NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The environment's databases, then the saved file's, in that order. A name
 * in both is an error rather than one silently winning. No database at all
 * is an empty list: the fleet offers to add one.
 */
export function readDatabases(env: Record<string, string | undefined>): DatabaseConfig[] {
  const path = savedPath(env);
  const all: DatabaseConfig[] = [
    ...fromEnv(env).map((d) => ({ ...d, source: 'env' as const })),
    ...readSaved(path, !env.PGOPS_CONFIG_FILE).map((d) => ({ ...d, source: 'saved' as const })),
  ];
  const seen = new Set<string>();
  for (const d of all) {
    if (seen.has(d.name)) throw new ConfigError(`${d.name} is set in the environment and also saved in ${path}.`);
    seen.add(d.name);
  }
  return all;
}

function fromEnv(env: Record<string, string | undefined>): { name: string; url: string }[] {
  const many = env.PGOPS_DATABASES;
  if (many) return parseMany(many, 'PGOPS_DATABASES', false);
  const one = env.DATABASE_URL;
  if (one) return [{ name: 'default', url: one }];
  return [];
}

/**
 * Where the console saves the databases added in it. PGOPS_CONFIG_FILE, when
 * set, is that file: a mounted one is the only form that keeps connection
 * strings out of the process environment (visible to `docker inspect` and
 * /proc/<pid>/environ).
 */
export function savedPath(env: Record<string, string | undefined>): string {
  return env.PGOPS_CONFIG_FILE || join(env.HOME || homedir(), '.pgops', 'databases.json');
}

/**
 * Read synchronously, on every request, deliberately: `readDatabases` is on
 * the render path of every page, and async would push `await` through every
 * Server Component that lists databases.
 *
 * A missing file at the default path is nothing saved yet. A missing
 * PGOPS_CONFIG_FILE is an error: a mistyped mount would otherwise read as an
 * empty console, and the first Add would write beside the real file.
 */
function readSaved(path: string, missingOk: boolean): { name: string; url: string }[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (missingOk && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigError(`${path} could not be read: ${(err as Error).message}`);
  }
  return parseMany(raw, path, true);
}

/** Throws what is wrong with adding `entry`, checked against every configured database. */
export function assertNew(env: Record<string, string | undefined>, entry: { name: string; url: string }): DatabaseConfig[] {
  if (!NAME.test(entry.name)) throw new ConfigError(`The name must match ${NAME.source}: it becomes a URL path segment.`);
  if (entry.url === '') throw new ConfigError('The connection URL is empty.');
  const all = readDatabases(env);
  if (all.some((d) => d.name === entry.name)) throw new ConfigError(`A database named ${entry.name} is already configured.`);
  return all;
}

/** Add one database to the saved file. */
export function saveDatabase(env: Record<string, string | undefined>, entry: { name: string; url: string }): void {
  writeSaved(env, [...saved(assertNew(env, entry)), entry]);
}

/** Remove one saved database, and return it. One set in the environment is changed there. */
export function removeDatabase(env: Record<string, string | undefined>, name: string): DatabaseConfig {
  const all = readDatabases(env);
  const db = all.find((d) => d.name === name);
  if (!db) throw new ConfigError(`No database named ${name} is configured.`);
  if (db.source === 'env') throw new ConfigError(`${name} is set in the environment; remove it there.`);
  writeSaved(env, saved(all).filter((d) => d.name !== name));
  return db;
}

function saved(all: DatabaseConfig[]): { name: string; url: string }[] {
  return all.filter((d) => d.source === 'saved').map(({ name, url }) => ({ name, url }));
}

/**
 * Owner-only, because the file holds passwords, and whole: a write cut short
 * would leave JSON every page fails to parse. A file written beside it and
 * renamed over it is both. A rename cannot replace a file mounted on its own
 * (a single-file bind mount), so that one is narrowed first and then written
 * in place; one pgops cannot narrow is not written at all.
 */
function writeSaved(env: Record<string, string | undefined>, list: { name: string; url: string }[]): void {
  const path = savedPath(env);
  const body = `${JSON.stringify(list, null, 2)}\n`;
  const beside = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(beside, body, { mode: 0o600 });
      renameSync(beside, path);
    } catch {
      rmSync(beside, { force: true });
      // Narrowed, never widened: a file the operator made read only stays so.
      chmodSync(path, statSync(path).mode & 0o600);
      writeFileSync(path, body);
    }
  } catch (err) {
    throw new ConfigError(`${path} could not be written: ${(err as Error).message}`);
  }
}

// `source` names the variable or the file the raw JSON came from, so every
// message below points at the input the operator set. The saved file may be
// empty: removing the last database leaves `[]`.
function parseMany(raw: string, source: string, emptyOk: boolean): { name: string; url: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A raw SyntaxError would read as a bug in pgops rather than a typo in
    // the operator's configuration.
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || (parsed.length === 0 && !emptyOk)) {
    throw new ConfigError(`${source} must be a ${emptyOk ? '' : 'non-empty '}JSON array of {name, url}.`);
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
