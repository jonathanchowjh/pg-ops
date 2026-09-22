import type { Metadata } from 'next';
import { ExplainForm } from '@/components/explain-form';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Explain` };
}

/**
 * #57 `explain` and #64 `best_index`: paste a statement, read its plan and
 * which index — if any — would serve it.
 *
 * The page itself reads no configuration and contacts no database; the form
 * posts to the tier-0 explain route, which does. No `<Refresh>`: nothing here
 * changes unless the operator asks again.
 */
export default async function Explain({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <>
      <section className="space-y-4 rounded-lg border p-4">
        <header className="space-y-1">
          <h2 className="font-semibold">Explain</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Plans the statement without running it. <code>$1</code>-style parameters are planned
            generically, so a shape copied from the Queries tab works as it is. No{' '}
            <code>ANALYZE</code>: that would execute the statement.
          </p>
        </header>
        <ExplainForm name={name} />
      </section>
    </>
  );
}
