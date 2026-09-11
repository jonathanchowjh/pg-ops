/**
 * What an operator sees when pgops cannot read its own configuration.
 *
 * F4 (final review): `ConfigError` used to escape uncaught out of
 * `databaseNames()` on both routes that call it, so Next answered with its
 * generic 500 page and the message — which names the exact input the operator
 * set, and was Task 1's entire justification — survived only in the container
 * log. A blank 500 sends an on-call engineer to the database. This sends them
 * to the deployment they just changed.
 *
 * Deliberately not `notFound()` and deliberately not a thrown error: neither
 * of those can carry a message, and the message is the whole value here.
 */
export function ConfigErrorPage({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">pgops is not configured</h1>
      <div className="rounded-lg border border-l-4 border-l-warning p-4 text-sm">
        <p className="mb-2 font-medium">The console could not read its database configuration.</p>
        <p className="text-muted-foreground">{message}</p>
      </div>

      {/* The message above names what is WRONG. This names what RIGHT looks
          like. They are different questions, and the page answered only the
          first — leaving an operator who is mid-deploy, and who reached this
          page precisely because they do not have the shape in their head, to
          go and find the README. Three inputs, in the precedence order the
          server actually applies them, so the page also answers the follow-up
          question: which one wins when more than one is set. */}
      <section className="mt-4 rounded-lg border p-4 text-sm">
        <h2 className="mb-3 font-medium">Set one of these, highest precedence first</h2>
        <dl className="grid gap-3">
          <div>
            <dt className="font-mono text-xs font-medium">PGOPS_CONFIG_FILE</dt>
            <dd className="text-muted-foreground">
              Path to a file holding the JSON array below. The only option that keeps connection
              strings out of the process environment.
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs font-medium">PGOPS_DATABASES</dt>
            <dd className="text-muted-foreground">
              <code className="break-all">{'[{"name":"prod","url":"postgres://…"}]'}</code>
              {' — '}each <code>name</code> becomes a URL path segment, so it must match{' '}
              <code>[A-Za-z0-9_-]+</code> and be unique.
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs font-medium">DATABASE_URL</dt>
            <dd className="text-muted-foreground">
              One connection string, for a single database named <code>default</code>.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-muted-foreground">
          Configuration is read per request, so a corrected environment takes effect on the next
          reload — the container does not need rebuilding.
        </p>
      </section>
    </main>
  );
}
