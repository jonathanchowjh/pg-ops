import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecentAudit, writeAudit } from '../src/actions/audit.js';

/**
 * Pure unit coverage for `writeAudit` — no Postgres involved, same reasoning
 * as `redact.test.ts` for `redactSecrets`: what this function does to a
 * string/file is unrelated to any server, so it belongs in the `unit`
 * project rather than `kill.int.test.ts`'s container-backed run.
 */
describe('writeAudit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pgops-audit-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('writes a redacted JSON line to both stdout and the file', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = join(dir, 'audit.log');

    await writeAudit(
      {
        action: 'kill',
        subcommand: 'sessions',
        target: { pid: 42, query: "ALTER USER app PASSWORD 'hunter2'" },
        reason: 'incident triage',
        result: 'terminated',
      },
      path,
    );

    // stdout: the audit record's real home (see the doc comment on
    // writeAudit) — must have received exactly the one line.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const stdoutLine = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(stdoutLine).not.toContain('hunter2');
    expect(stdoutLine).toContain('***');

    const fileContent = await readFile(path, 'utf8');
    expect(fileContent).toBe(stdoutLine);

    const parsed = JSON.parse(fileContent) as Record<string, unknown>;
    expect(parsed.action).toBe('kill');
    expect(parsed.subcommand).toBe('sessions');
    expect(parsed.result).toBe('terminated');
    expect(parsed.reason).toBe('incident triage');
    expect(typeof parsed.timestamp).toBe('string');
    expect(typeof parsed.user).toBe('string');
    // A killed session's query is exactly the text redactSecrets exists for
    // (the brief's own framing) — prove it survives into `target`, redacted.
    expect(String((parsed.target as Record<string, unknown>).query)).not.toContain('hunter2');
  });

  it('does not reject when the file write fails, and surfaces the failure instead of swallowing it', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A file where the audit log's PARENT directory is expected to be:
    // mkdir(dirname(path), { recursive: true }) then fails with ENOTDIR, the
    // way a misconfigured PGOPS_AUDIT_LOG would in production.
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x');
    const path = join(blocker, 'audit.log');

    await expect(
      writeAudit({ action: 'kill', subcommand: 'sessions', target: { pid: 1 }, result: 'gone' }, path),
    ).resolves.toBeUndefined();

    // Not swallowed: the failure is visible on stderr.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(path);
  });

  it('still creates the file\'s parent directory when it does not exist yet', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = join(dir, 'nested', 'audit.log');

    await writeAudit({ action: 'kill', subcommand: 'sessions', target: {}, result: 'gone' }, path);

    const fileContent = await readFile(path, 'utf8');
    expect(JSON.parse(fileContent)).toMatchObject({ action: 'kill', result: 'gone' });
  });

  /**
   * Fix-round 1: the first version of this function guarded ONLY the file
   * write — `redactSecrets(JSON.stringify(full))` and
   * `process.stdout.write(line)` sat outside any try/catch, contradicting
   * the doc comment's own claim that writeAudit "never rejects". This is
   * not a hypothetical failure: `pgops kill ... | head` closes the read end
   * of the pipe as soon as `head` has what it wants, and the very next
   * `process.stdout.write` in the writing process throws synchronously with
   * `code: 'EPIPE'`. Mocked here (a real closed pipe isn't practical to
   * construct inside a unit test), but with the same error shape Node
   * itself raises, and asserting both halves of the contract: the promise
   * still resolves, AND the file write is still attempted despite stdout
   * having failed first (defence in depth — one channel's failure does not
   * take out the other's chance to preserve the record).
   */
  it('does not reject when stdout write throws (EPIPE), and still attempts the file write', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => { throw epipe; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'audit.log');

    await expect(
      writeAudit({ action: 'kill', subcommand: 'sessions', target: { pid: 7 }, result: 'terminated' }, path),
    ).resolves.toBeUndefined();

    // The stdout failure was surfaced, not swallowed...
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stdout'), epipe);
    // ...and the file still got the record, proving the two writes are
    // independent rather than one aborting the other.
    const fileContent = await readFile(path, 'utf8');
    expect(JSON.parse(fileContent)).toMatchObject({ action: 'kill', result: 'terminated' });
  });

  /**
   * Fix-round 1: `target` carries caller-supplied metadata (`KillMeta.extra`
   * in kill.ts) whose shape this function does not control. Plain
   * `JSON.stringify` throws on a circular reference or a BigInt — either
   * would previously have discarded the WHOLE record (pid, result,
   * everything) because of one unrelated bad field. `safeStringify` closes
   * this by construction: both survive as a marked value instead of an
   * exception, and the rest of the record — the actual audit subject —
   * still reaches disk and stdout intact.
   */
  it('survives a circular reference and a BigInt in target metadata instead of losing the record', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = join(dir, 'audit.log');

    // A direct self-reference (not one reached through a spread, which
    // would insert a SECOND object into the graph and mark the cycle one
    // level deeper than this test wants to assert on).
    const target: Record<string, unknown> = { pid: 9, big: BigInt(10) };
    target.self = target;

    await expect(
      writeAudit(
        { action: 'kill', subcommand: 'sessions', target, result: 'terminated' },
        path,
      ),
    ).resolves.toBeUndefined();

    const fileContent = await readFile(path, 'utf8');
    const parsed = JSON.parse(fileContent) as Record<string, unknown>;
    // The record survived: subcommand/result/pid are all intact, not lost
    // to a thrown JSON.stringify.
    expect(parsed.result).toBe('terminated');
    expect((parsed.target as Record<string, unknown>).pid).toBe(9);
    expect((parsed.target as Record<string, unknown>).self).toBe('[Circular]');
    expect((parsed.target as Record<string, unknown>).big).toBe('10n');
  });

  describe('readRecentAudit', () => {
    it('returns the newest records for one database, skipping a corrupt line', async () => {
      const path = join(dir, 'audit.log');
      await writeAudit({ action: 'kill', subcommand: 'web/sessions', target: { database: 'prod', pid: 1 }, reason: 'a', result: 'terminated', timestamp: '2026-01-01T00:00:00Z' }, path);
      await writeAudit({ action: 'kill', subcommand: 'web/sessions', target: { database: 'staging', pid: 2 }, reason: 'b', result: 'terminated', timestamp: '2026-01-01T00:00:01Z' }, path);
      await appendFile(path, 'not json\n');
      await writeAudit({ action: 'kill', subcommand: 'web/sessions', target: { database: 'prod', pid: 3 }, reason: 'c', result: 'gone', timestamp: '2026-01-01T00:00:02Z' }, path);
      const out = await readRecentAudit({ database: 'prod', path });
      expect(out.records.map((r) => r.target.pid)).toEqual([3, 1]);
      expect(out.unreadable).toBeNull();
    });

    it('returns an empty, readable history when the file does not exist', async () => {
      expect(await readRecentAudit({ database: 'prod', path: join(dir, 'missing.log') }))
        .toEqual({ records: [], unreadable: null });
    });

    /**
     * Critical review finding: a missing file (ENOENT, above) is a
     * legitimately empty history and must render nothing; anything else
     * that keeps the file from being read — here, a directory sitting where
     * the audit log is expected — must be SAID, because this is this
     * console's only record of who terminated what, and silence here reads
     * to an operator as "nothing was done" rather than "the record is gone".
     */
    it('reports unreadable, not an empty history, when the file cannot be read for a reason other than being absent', async () => {
      const path = join(dir, 'a-directory');
      await mkdir(path);
      const out = await readRecentAudit({ database: 'prod', path });
      expect(out.records).toEqual([]);
      expect(out.unreadable).not.toBeNull();
      expect(out.unreadable).toBe('EISDIR');
    });

    /**
     * Strengthened past a bare `toHaveLength(2)`: that assertion alone
     * cannot tell newest-first from oldest-first — a mutation that sliced
     * from the wrong end would return the two OLDEST records and still pass
     * it. Asserting WHICH two pids come back pins the direction.
     */
    it('honours the limit, keeping the newest records rather than the oldest', async () => {
      const path = join(dir, 'limit.log');
      for (let i = 0; i < 5; i++) {
        await writeAudit({ action: 'kill', subcommand: 's', target: { database: 'prod', pid: i }, reason: 'r', result: 'terminated' }, path);
      }
      const out = await readRecentAudit({ database: 'prod', path, limit: 2 });
      expect(out.records.map((r) => r.target.pid)).toEqual([4, 3]);
    });
  });
});
