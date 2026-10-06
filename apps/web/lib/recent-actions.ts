import { readRecentAudit, type RecentAudit } from '@pgops/checks';

/**
 * The last ten audited actions against this database, newest first, and
 * whether the audit log could not be read.
 *
 * Never throws — but the catch below must not flatten "could not read" into
 * the same empty shape a clean, missing-file empty history produces
 * (`readRecentAudit` itself already tells those two apart; see its
 * `RecentAudit` doc comment). `readRecentAudit` is documented as never
 * throwing, so this catch exists only for a failure in something other than
 * the read itself — and even that unlikely case must still say so, per this
 * console's rule that "we could not look" never renders the same as "we
 * looked and it is fine".
 */
export async function recentActionsFor(name: string): Promise<RecentAudit> {
  try {
    return await readRecentAudit({ database: name, limit: 10 });
  } catch {
    return { records: [], unreadable: 'error' };
  }
}
