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
      <div className="rounded-lg border p-4 text-sm">
        <p className="mb-2 font-medium">The console could not read its database configuration.</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
