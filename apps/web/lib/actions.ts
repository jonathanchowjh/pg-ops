/**
 * The tier-1 gate, spec §7.1. Actions are off by default: a deployment that
 * never sets this cannot reach the kill route at all, because the route
 * answers 404.
 *
 * Compared strictly against the one documented value rather than tested for
 * truthiness. `Boolean(process.env.PGOPS_ALLOW_ACTIONS)` is true for the
 * string "false", which is exactly what an operator writes when they want
 * this off and are being explicit about it. A permissive parser on the gate
 * in front of pg_terminate_backend is not a convenience.
 */
export function actionsAllowed(env: Record<string, string | undefined>): boolean {
  return (env.PGOPS_ALLOW_ACTIONS ?? '').trim().toLowerCase() === 'true';
}
