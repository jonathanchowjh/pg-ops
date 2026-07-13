import { describe, expect, it } from 'vitest';
import { safeTarget } from './connection.js';

/**
 * `safeTarget` is the single credential-redaction chokepoint for every view's
 * status bar and snapshot header (plan §G, Secrets handling). The property under
 * test is absolute: credentials never survive into rendered output.
 */
describe('safeTarget', () => {
  it('redacts credentials, keeping host:port/db', () => {
    expect(safeTarget('postgres://user:secret@host:5432/db')).toBe('host:5432/db');
  });

  it('never leaks the password or the user for any URL shape', () => {
    const urls = [
      'postgres://user:secret@host:5432/db',
      'postgresql://user:secret@host/db',
      'postgres://user:secret@host:5432/db?sslmode=require',
      'postgres://user:s3cr%40t@10.0.0.1:6543/appdb',
    ];
    for (const url of urls) {
      const shown = safeTarget(url);
      expect(shown).toBeDefined();
      expect(shown).not.toContain('secret');
      expect(shown).not.toContain('s3cr');
      expect(shown).not.toContain('user');
      expect(shown).not.toContain('@');
      expect(shown).not.toContain(':/');
    }
  });

  it('omits the port when the URL has none', () => {
    expect(safeTarget('postgres://user:secret@host/db')).toBe('host/db');
  });

  it('omits the database when the URL has no path', () => {
    expect(safeTarget('postgres://user:secret@host:5432')).toBe('host:5432');
  });

  it('returns undefined for a malformed connection string rather than throwing', () => {
    expect(safeTarget('not a url')).toBeUndefined();
    expect(safeTarget('postgres://')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(safeTarget(undefined)).toBeUndefined();
    expect(safeTarget('')).toBeUndefined();
  });
});
