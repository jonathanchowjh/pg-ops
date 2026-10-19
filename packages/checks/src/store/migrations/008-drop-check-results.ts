/**
 * Migration 008 — the hygiene cache goes.
 *
 * It held a level and a note per check. The catalog is stored whole now
 * (migration 007), and what a row is flagged with is worked out where it is
 * shown. Migration 003 still creates the table on a store built from
 * nothing, because migrations are forward-only and numbered; this drops it.
 */
export const SQL = `
DROP TABLE IF EXISTS pgops.check_results;
`;
