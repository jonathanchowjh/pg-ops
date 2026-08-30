import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { ConfigErrorPage } from '@/components/config-error';
import { Nav } from '@/components/nav';
import { Refresh } from '@/components/refresh';

export default async function DbLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ name: string }>;
}) {
  // Reads process.env via databaseNames() — see the plan's Global Constraints.
  await connection();
  const { name } = await params;
  // F4 (final review): the configuration branch comes FIRST, and the order
  // matters. With no readable configuration at all, `databaseNames()` throws
  // rather than returning an empty list — so before this, every /db/* URL
  // answered with Next's generic 500 and the message that names the
  // operator's own input never left the container log.
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }

  // An unconfigured name is a 404, not a 500: the operator mistyped, pgops is
  // not broken, and the distinction is the whole difference between "check the
  // URL" and "page the on-call for the tool itself". A misconfigured console
  // is neither — it is handled above, because 404 here would be a true
  // statement ("no such database") that points at the wrong thing.
  if (!names.includes(name)) notFound();

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-2 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">{name}</h1>
        <Refresh intervalMs={5_000} />
      </header>
      <Nav name={name} />
      {children}
    </main>
  );
}
