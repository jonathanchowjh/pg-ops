/**
 * HTTP basic auth, spec §7.2. pgHero's shape: two environment variables, a
 * 401 with a WWW-Authenticate challenge, and documentation that says plainly
 * this is the floor and a reverse proxy (OAuth2 Proxy, ALB auth, IAP) is the
 * answer for anything real.
 *
 * The logic lives here, as a pure function of (env, header), rather than in
 * proxy.ts: a proxy function needs a NextRequest and a running Next runtime
 * to invoke, so every interesting branch — a password containing a colon,
 * half-configured auth, a malformed scheme — would otherwise be reachable
 * only through an integration test that boots a server. Same split as
 * components/refresh.tsx, where nextTick/onTick hold the logic.
 */

/**
 * The header proxy.ts sets, after successful authentication, so the kill
 * route can name the human in the audit record. Exported so exactly one
 * string exists: proxy.ts and a route that disagreed about its spelling
 * would silently audit every kill as anonymous.
 */
export const ACTOR_HEADER = 'x-pgops-user';

export type AuthResult =
  | { ok: true; user: string | null }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Constant-time string comparison, without node:crypto's `timingSafeEqual`.
 * Not a runtime constraint — proxy.ts always runs on the Node.js runtime (see
 * that file's docblock) — but a correctness one: `timingSafeEqual` throws on
 * unequal-length buffers, so using it would first require this function to
 * pad or reject on length itself, in service of a primitive that buys
 * nothing extra here. This comparison needs no cryptographic property beyond
 * "does not branch on where the difference is", and eleven lines of char-code
 * arithmetic are exhaustively unit tested by auth.test.ts's wrong-username
 * and wrong-password cases, which is exercise enough for something this
 * small — more confidence than reaching for a library call would buy here.
 *
 * `charCodeAt` past the end of a string returns NaN, and `NaN | 0` is 0, so
 * two out-of-range positions compare equal to each other. That is why the
 * length difference is folded in FIRST and separately: without it, "ab" and
 * "ab\0\0" would compare equal. The loop always runs to the longer of the two
 * lengths, so the time taken depends on the lengths (which basic auth leaks
 * anyway, in the base64 blob's size) and never on where the first difference
 * falls.
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
 * RFC 7617, which mandates UTF-8. `atob` and `TextDecoder` are the platform
 * primitives for this — no import, no dependency, available wherever this
 * module runs.
 *
 * `atob` alone decodes base64 to a BINARY string: one JS char per BYTE.
 * `env.PGOPS_PASSWORD` is a UTF-8-decoded JS string: one char per CODE
 * POINT. For any password outside the Latin-1 range (0-255) those two
 * disagree on every multi-byte character, so comparing `atob`'s output
 * directly against the env value rejected a CORRECTLY typed non-ASCII
 * password — indistinguishable from a wrong one, and permanently: the
 * operator can never satisfy it. Same failure mode the colon-splitting case
 * below exists to prevent. Feeding `atob`'s bytes through `TextDecoder`
 * turns them into the same code-point string `env` already is, so both
 * sides of `safeEqual` compare like with like. Only the FIRST colon
 * separates user from password — a password containing colons is legal and
 * common, and splitting on every colon locks those operators out with a 401
 * that reads as "wrong password".
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

export function authorize(
  env: Record<string, string | undefined>,
  authorization: string | null,
): AuthResult {
  const user = env.PGOPS_USERNAME;
  const pass = env.PGOPS_PASSWORD;

  // Half-configured is a hard failure, not an open door — see the plan's
  // Ruling 4. An operator who set one of these meant to require auth; serving
  // the console (with its kill button) openly because they missed the other
  // is the failure that matters. 503 rather than 401: a 401 invites password
  // guesses against a pair that can never match.
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
  // timing which HALF was wrong — see the plan's Ruling 3.
  const userOk = safeEqual(supplied.user, user);
  const passOk = safeEqual(supplied.pass, pass);
  if (!(userOk && passOk)) return { ok: false, status: 401, message: 'Authentication required.' };

  return { ok: true, user: supplied.user };
}
