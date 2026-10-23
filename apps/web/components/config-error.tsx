/**
 * What an operator sees when pgops cannot read its own configuration. Not
 * `notFound()` and not a thrown error: neither can carry the message, which
 * names the input the operator set. No configuration at all is not this: the
 * fleet offers to add a database.
 */
export function ConfigErrorPage({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">pgops cannot read its configuration</h1>
      <div className="rounded-lg border border-l-4 border-l-warning p-4 text-sm">
        <p className="text-muted-foreground">{message}</p>
      </div>

      <section className="mt-4 rounded-lg border p-4 text-sm">
        <h2 className="mb-3 font-medium">Where pgops reads databases from</h2>
        <dl className="grid gap-3">
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
              One connection string, for a single database named <code>default</code>. Read when PGOPS_DATABASES is unset.
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs font-medium">PGOPS_CONFIG_FILE</dt>
            <dd className="text-muted-foreground">
              The file the databases added in the console are saved to, holding the same JSON array.
              Defaults to <code>~/.pgops/databases.json</code>.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-muted-foreground">
          Configuration is read per request, so a corrected environment or file takes effect on the next
          reload.
        </p>
      </section>
    </main>
  );
}
