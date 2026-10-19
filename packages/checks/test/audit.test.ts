import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAudit } from '../src/actions/audit.js';

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
    // A killed session's query reaches `target` redacted.
    expect(String((parsed.target as Record<string, unknown>).query)).not.toContain('hunter2');
  });

  it('does not reject when the file write fails, and surfaces the failure instead of swallowing it', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A file where the audit log's parent directory should be, so mkdir fails
    // with ENOTDIR the way a misconfigured PGOPS_AUDIT_LOG would.
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x');
    const path = join(blocker, 'audit.log');

    await expect(
      writeAudit({ action: 'kill', subcommand: 'sessions', target: { pid: 1 }, result: 'gone' }, path),
    ).resolves.toBeUndefined();

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
   * `pgops kill ... | head` closes the pipe, and the next
   * `process.stdout.write` throws synchronously with `code: 'EPIPE'`. Mocked
   * here with the error shape Node raises.
   */
  it('does not reject when stdout write throws (EPIPE), and still attempts the file write', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => { throw epipe; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = join(dir, 'audit.log');

    await expect(
      writeAudit({ action: 'kill', subcommand: 'sessions', target: { pid: 7 }, result: 'terminated' }, path),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stdout'), epipe);
    // The two writes are independent: the file still got the record.
    const fileContent = await readFile(path, 'utf8');
    expect(JSON.parse(fileContent)).toMatchObject({ action: 'kill', result: 'terminated' });
  });

  /**
   * `target` carries caller-supplied metadata. Plain `JSON.stringify` throws
   * on a circular reference or a BigInt, which would discard the whole record
   * for one bad field.
   */
  it('survives a circular reference and a BigInt in target metadata instead of losing the record', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = join(dir, 'audit.log');

    // A direct self-reference: one reached through a spread would mark the
    // cycle one level deeper than the assertion below.
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
    expect(parsed.result).toBe('terminated');
    expect((parsed.target as Record<string, unknown>).pid).toBe(9);
    expect((parsed.target as Record<string, unknown>).self).toBe('[Circular]');
    expect((parsed.target as Record<string, unknown>).big).toBe('10n');
  });
});
