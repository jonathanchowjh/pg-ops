/**
 * What an operator sees when pgops cannot read its own configuration. Not
 * `notFound()` and not a thrown error: neither can carry the message, which
 * names the input the operator set.
 */
export function ConfigErrorPage({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">pgops is not configured</h1>
      <div className="rounded-lg border border-l-4 border-l-warning p-4 text-sm">
        <p className="mb-2 font-medium">The console could not read its database configuration.</p>
        <p className="text-muted-foreground">{message}</p>
      </div>

      {/* The three inputs, in the precedence order the server applies them. */}
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
