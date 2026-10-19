import type { Metadata } from 'next';
import { ExplainForm } from '@/components/explain-form';
import { NodeHead } from '@/components/node-head';

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Explain` };
}

/**
 * A statement pasted from anywhere: its generic plan, and which index, if
 * any, would serve it. Reached from the Queries head. The page reads no
 * configuration and contacts no database; the form posts to the tier-0
 * explain route. No clock: a plan is of no moment.
 */
export default async function Explain({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <>
      <NodeHead title="Explain" crumb={[{ label: name, href: `/db/${name}` }, { label: 'Queries', href: `/db/${name}/queries` }]}>
        <span className="text-xs text-muted-foreground">planned, never run</span>
      </NodeHead>
      <ExplainForm name={name} />
    </>
  );
}
