import { formatDuration, type RootBlocker } from './chain.js';

export interface Advice {
  text: string;
  tone: 'safe' | 'caution';
}

/** Heuristic verdict for the kill decision. Never auto-acts; advice only. */
export function adviseBlocker(root: RootBlocker): Advice {
  const age = formatDuration(root.heldForSecs);
  const secs = root.heldForSecs;
  const state = root.state ?? '';
  if (state.startsWith('idle in transaction')) {
    return { tone: 'safe', text: `stuck ${age}, no running query — likely safe to kill` };
  }
  // Only judge an active query when its age is actually known and non-negative.
  // A null age (missing xact_start) or negative age (clock skew) must NOT be
  // treated as "young" — that would advise waiting on an unknown-duration query.
  if (state === 'active' && secs != null && secs >= 0) {
    if (secs < 30) {
      return { tone: 'caution', text: `active query, ${age} — real work; killing rolls it back. consider waiting` };
    }
    return { tone: 'caution', text: `long-running active query (${age}) — stuck or heavy; judge by the query` };
  }
  return { tone: 'caution', text: `state ${state || 'unknown'} — inspect the query before killing` };
}
