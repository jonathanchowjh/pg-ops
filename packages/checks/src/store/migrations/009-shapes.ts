/**
 * Migration 009 — a statement is stored as its shape.
 *
 * Until this version a live statement's text was stored as
 * pg_stat_activity printed it, literals and all: an email, an account
 * number, a token in a `SET`, kept for as long as the samples. From now the
 * sampler stores the shape, every literal a placeholder. The texts already
 * stored are deleted rather than kept: a past sample whose text is gone
 * shows its statement without text until a session runs it again, which is
 * the cost of not keeping what was never meant to be stored.
 */
export const SQL = `
DELETE FROM pgops.sample_statements;
`;
