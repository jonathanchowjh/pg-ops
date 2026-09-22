import type { Metadata } from 'next';
import { CHECKS, type BloatedIndex } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Sql } from '@/components/sql';
import { formatBytes, formatCount } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Index bloat` };
}

/**
 * The ratio is DERIVED here, and returns null rather than a number it cannot
 * justify.
 *
 * pgHero's estimator computes `realbloat` in its `raw_bloat` CTE and then
 * never selects it — index-bloat.ts keeps that dead column rather than pruning
 * it, because the point of a transcription is that it diffs cleanly against
 * its source. So the division happens at the surface that wants it.
 *
 * `indexBytes === 0` would make the ratio meaningless, and `0 / 0` is NaN
 * while `n / 0` is Infinity — both of which render as text on a page. An
 * unmeasurable ratio is an absence, not a confident 0%.
 */
function bloatRatio(i: BloatedIndex): number | null {
  if (i.indexBytes <= 0) return null;
  return Math.round((i.bloatBytes / i.indexBytes) * 100);
}

/**
 * #29, on its own route because it is `class: 'on-demand'`.
 *
 * Reached by an explicit click from the indexes page, which links here with
 * the cost named rather than running this inline. pgHero reaches the same
 * conclusion from the other direction: it ships this DISABLED on its own
 * dashboard (`home_controller.rb:114` is `@index_bloat = [] #
 * @database.index_bloat`) behind a dedicated route.
 *
 * No `<Refresh>`. A check with a 30-second budget must not acquire a five
 * second poll by virtue of being on a page.
 */
export default async function Bloat({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = await runCheckFor(name, CHECKS.indexBloat, {});

  return (
    <>
      <CheckPanel title="Index bloat" result={result}>
        {(d) => (d.indexes.length === 0
          ? (
            // Names the FLOOR, not "no bloat". What the check establishes is
            // that nothing cleared 100 MB of waste — not that the database is
            // clean. The difference matters to an operator deciding whether
            // they have looked.
            <p className="text-sm text-muted-foreground">
              No index over 100&nbsp;MB shows measurable bloat. Smaller indexes are not
              estimated: pgHero&rsquo;s floor is adopted here, because bloat on a small
              index costs less than the scan that measures it.
            </p>
          )
          : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                These figures are an <strong>estimate</strong>, reconstructed from column
                statistics rather than measured — confirm before rebuilding anything.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Index</th>
                      <th className="py-1 pr-4 font-medium">Table</th>
                      <th className="py-1 pr-4 text-right font-medium">Size</th>
                      <th className="py-1 pr-4 text-right font-medium">Estimated bloat</th>
                      <th className="py-1 text-right font-medium">Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.indexes.map((i: BloatedIndex) => {
                      const ratio = bloatRatio(i);
                      return (
                        <tr key={i.name} className="border-t align-top">
                          <td className="py-1 pr-4">
                            <span className="font-mono">{i.name}</span>
                            {i.primary ? (
                              // A primary key cannot simply be dropped, so the
                              // obvious remedy is not available for this row.
                              <span className="text-muted-foreground"> · primary key</span>
                            ) : null}
                            <Sql>{i.definition}</Sql>
                          </td>
                          <td className="py-1 pr-4 font-mono">{i.table}</td>
                          <td className="py-1 pr-4 text-right tabular-nums">
                            {formatBytes(i.indexBytes)}
                          </td>
                          <td className="py-1 pr-4 text-right tabular-nums">
                            {formatBytes(i.bloatBytes)}
                          </td>
                          <td className="py-1 text-right tabular-nums">
                            {ratio === null ? '—' : `${ratio}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {d.total > d.indexes.length ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Showing {formatCount(d.indexes.length)} of {formatCount(d.total)}. Narrow the
                  database or raise the cap to see the rest.
                </p>
              ) : null}
            </>
          ))}
      </CheckPanel>
    </>
  );
}
