/**
 * HTTP basic auth: two environment variables and a 401 with a
 * WWW-Authenticate challenge. This is the floor; a reverse proxy (OAuth2
 * Proxy, ALB auth, IAP) is the answer for anything real.
 *
 * The logic lives here, as a pure function of (env, header), rather than in
 * proxy.ts, so every branch is testable without booting a server.
 */

/**
 * The header proxy.ts sets, after successful authentication, so the kill
 * route can name the human in the audit record.
 */
export const ACTOR_HEADER = 'x-pgops-user';

export type AuthResult =
  | { ok: true; user: string | null }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Constant-time string comparison, without node:crypto's `timingSafeEqual`,
 * which throws on unequal-length buffers. auth.test.ts covers it.
 *
 * `charCodeAt` past the end of a string returns NaN, and `NaN | 0` is 0, so
 * the length difference is folded in first: without it, "ab" and "ab\0\0"
 * would compare equal. The loop runs to the longer length, so the time taken
 * depends on the lengths (which basic auth leaks anyway) and never on where
 * the first difference falls.
 */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * RFC 7617, which mandates UTF-8.
 *
 * `atob` alone decodes base64 to a binary string: one JS char per byte.
 * `env.PGOPS_PASSWORD` is a UTF-8-decoded JS string: one char per code
 * point. Compared directly, a correctly typed non-ASCII password would be
 * rejected, so `atob`'s bytes go through `TextDecoder` first.
 *
 * Only the first colon separates user from password: a password containing
 * colons is legal.
 */
function decodeBasic(header: string): { user: string; pass: string } | null {
  const space = header.indexOf(' ');
  if (space < 0) return null;
  if (header.slice(0, space).toLowerCase() !== 'basic') return null;
  const encoded = header.slice(space + 1).trim();
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

/** Whether basic auth is switched on at all. Half-configured counts: `authorize` refuses everything then. */
export function authConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.PGOPS_USERNAME) || Boolean(env.PGOPS_PASSWORD);
}

export function authorize(
  env: Record<string, string | undefined>,
  authorization: string | null,
): AuthResult {
  const user = env.PGOPS_USERNAME;
  const pass = env.PGOPS_PASSWORD;

  // Half-configured is a hard failure, not an open door: an operator who set
  // one of these meant to require auth. 503 rather than 401: a 401 invites
  // password guesses against a pair that can never match.
  if (Boolean(user) !== Boolean(pass)) {
    const missing = user ? 'PGOPS_PASSWORD' : 'PGOPS_USERNAME';
    return {
      ok: false,
      status: 503,
      message:
        `pgops is misconfigured: ${missing} is not set, but its counterpart is. ` +
        'Set both to require authentication, or neither to run without it.',
    };
  }

  if (!user || !pass) return { ok: true, user: null };

  const supplied = authorization ? decodeBasic(authorization) : null;
  if (!supplied) return { ok: false, status: 401, message: 'Authentication required.' };

  // Both comparisons run unconditionally. `&&` would short-circuit on a wrong
  // username and never touch the password, which leaks through response
  // timing which half was wrong.
  const userOk = safeEqual(supplied.user, user);
  const passOk = safeEqual(supplied.pass, pass);
  if (!(userOk && passOk)) return { ok: false, status: 401, message: 'Authentication required.' };

  return { ok: true, user: supplied.user };
}
