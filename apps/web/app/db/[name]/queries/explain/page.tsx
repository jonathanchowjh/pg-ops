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
      {/* NO BOX. P7d made a border mean "an escalated verdict is in here"
          (check-panel.tsx), and this one wrapped the entire page — so it said
          nothing except "alarm" to an operator trained by the triage page.
          Every other sub-route under Queries sits flush on the page, and the
          heading below already separates the tool from the nav above it. */}
      <section className="space-y-4">
        <header className="space-y-1">
          <h2 className="border-b pb-2 font-medium">Explain</h2>
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
