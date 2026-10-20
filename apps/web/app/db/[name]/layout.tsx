import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { ConfigErrorPage } from '@/components/config-error';
import { Sidebar } from '@/components/sidebar';
import { identityLine } from '@/lib/format';
import { runCheckFor } from '@/lib/check';
import { CHECKS } from '@pgops/checks';

export default async function DbLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ name: string }>;
}) {
  // databaseNames() reads process.env, so this must be dynamic.
  await connection();
  const { name } = await params;
  // With no readable configuration `databaseNames()` throws rather than
  // returning an empty list. Caught here so the page shows the message
  // instead of Next's generic 500.
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }

  // An unconfigured name is a 404, not a 500: the operator mistyped, pgops is
  // not broken.
  if (!names.includes(name)) notFound();

  // In the layout so identity is on every page under /db/<name>, including
  // the one with the terminate button. `runCheckFor` never rejects.
  const who = await runCheckFor(name, CHECKS.identity);

  // The sidebar is the place; the page under it says which node and when.
  return (
    <div className="grid min-h-screen grid-cols-[minmax(0,1fr)] max-md:grid-rows-[auto_1fr] md:grid-cols-[208px_minmax(0,1fr)]">
      <Sidebar name={name} />
      <main className="min-w-0 px-4 pb-16 text-[13px]/5 md:px-5">
        {/* What the server on the other end says it is, on every page under /db/<name>, including the
            ones with Terminate. Every other surface names a database by the operator's label; this line
            is the one place the server answers. See checks/identity.ts. */}
        <p className="pt-2 text-xs text-muted-foreground">{identityLine(who.ok ? who.data : null)}</p>
        {children}
      </main>
    </div>
  );
}
