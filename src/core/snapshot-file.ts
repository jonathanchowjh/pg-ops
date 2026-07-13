import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StatusMessage } from './theme.js';
import { buildSnapshot } from './snapshot.js';

/**
 * The `[s]` snapshot-to-file path, shared by every view.
 *
 * Was four copy-pasted mkdir/writeFile/setMessage blocks. One copy: build the
 * envelope (which redacts — core/snapshot.ts), write it under
 * `~/.pgops/snapshots/`, and hand back the status-bar message either way. Never
 * throws: a failed snapshot write reports itself in the bar, it does not take
 * the view down mid-incident.
 */
export interface SaveSnapshotOptions {
  /** Snapshot label, e.g. "locks", "triage". */
  subcommand: string;
  /** Credential-free target label for the header. */
  target?: string;
  /** View-produced markdown body. */
  body: string;
  /** Filename prefix; defaults to `subcommand` (the cockpit writes `home-*.md`). */
  filePrefix?: string;
}

export async function saveSnapshot(opts: SaveSnapshotOptions): Promise<StatusMessage> {
  const md = buildSnapshot(
    { subcommand: opts.subcommand, timestamp: new Date().toISOString(), target: opts.target },
    opts.body,
  );
  const dir = join(homedir(), '.pgops', 'snapshots');
  const file = join(dir, `${opts.filePrefix ?? opts.subcommand}-${Date.now()}.md`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, md, 'utf8');
    return { text: `snapshot → ${file}`, color: 'success' };
  } catch (err) {
    return { text: `snapshot failed: ${(err as Error).message}`, color: 'critical' };
  }
}
