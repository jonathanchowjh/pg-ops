import type { ReactNode } from 'react';
import { indexFlags, tableFlags, type IndexRead, type SequenceEntry, type TableRead } from '@pgops/checks';
import { Time } from '@/components/clock';
import { EntityLink } from '@/components/entity-link';
import { NEAR_LIMIT_PCT } from '@/lib/catalog';
import { formatBytes, formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The catalog's rows: a table's facts, an index, a sequence. One component a
 * node kind, used on the population page and on the table's own. None of
 * them has a clock: the tree is activity, these are the catalog.
 */

const CELL = 'border-t px-3 py-[5px] whitespace-nowrap';
const NUM = cn(CELL, 'text-right font-mono text-foreground tabular-nums');
const NAME = 'font-mono text-foreground';
const QUIET = 'font-mono text-muted-foreground';

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="mr-1 inline-block rounded-[3px] px-1.5 text-[11px]/4 text-warning-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning-ink)_35%,transparent)]">
      {children}
    </span>
  );
}

/** A bar against a limit: `share` of the way there, in warning ink once `over`. `mark` is a threshold along it. */
export function Bar({ share, over = false, mark, className }: { share: number; over?: boolean; mark?: number; className?: string }) {
  const pct = (v: number): string => `${Math.max(0, Math.min(1, v)) * 100}%`;
  return (
    <div data-bar className={cn('relative h-2.5 min-w-[120px] rounded-xs bg-muted', className)}>
      <i className={cn('absolute inset-y-0 left-0 rounded-xs', over ? 'bg-warning-ink' : 'bg-foreground/75')} style={{ width: pct(share) }} />
      {mark === undefined ? null : <u className="absolute -inset-y-[3px] w-0.5 bg-foreground" style={{ left: pct(mark) }} />}
    </div>
  );
}

/** Catalog rows as a real table, in a card that scrolls sideways as one piece. A trailing `>` right-aligns a heading. */
export function List({ head, children }: { head: readonly string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className={cn(
                  'px-3 py-[5px] text-left text-[11px]/4 font-medium tracking-[0.05em] whitespace-nowrap text-muted-foreground uppercase',
                  h.endsWith('>') && 'text-right',
                )}
              >
                {h.replace(/>$/, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Table · rows · size · dead rows against the autovacuum trigger · last vacuumed · two tags at most. */
export function TableFactRow({ database, table, freezeMaxAge }: { database: string; table: TableRead; freezeMaxAge: number | null }) {
  const flags = tableFlags(table, freezeMaxAge);
  return (
    <tr>
      <td className={CELL}>
        <EntityLink database={database} name={table.name} className="font-mono font-semibold text-foreground hover:underline" />
      </td>
      <td className={NUM}>{formatCount(table.liveRows)}</td>
      <td className={NUM}>{formatBytes(table.sizeBytes)}</td>
      <td className={CELL}>
        {/* A partitioned parent holds no rows of its own to vacuum. */}
        {table.kind === 'partitioned' ? null : (
          <Bar share={table.vacuumTrigger > 0 ? table.deadRows / table.vacuumTrigger : 0} over={flags.includes('vacuum overdue')} />
        )}
      </td>
      <td className={NUM}><Time at={table.lastVacuum} /></td>
      <td className={CELL}>{flags.slice(0, 2).map((f) => <Tag key={f}>{f}</Tag>)}</td>
    </tr>
  );
}

/** Index and its columns · its table, on the population · size against the largest · size · scans · one tag. */
export function IndexRow({ database, index, largest, scans, withTable = false }: {
  database: string;
  index: IndexRead;
  /** The largest index in the list: the bar's whole width. */
  largest: number;
  /** The scans to print: the window's, or since the reset when no store keeps the hours. */
  scans: number;
  /** The Indexes population names the table; a table's own page does not. */
  withTable?: boolean;
}) {
  const [flag] = indexFlags(index);
  const tag = flag === 'duplicate' ? `duplicate of ${index.duplicateOf!.replace(/^.*\./, '')}` : flag;
  return (
    <tr>
      <td className={CELL}><span className={NAME}>{index.name}</span> <span className={QUIET}>({index.columns})</span></td>
      {withTable ? <td className={CELL}><EntityLink database={database} name={index.table} /></td> : null}
      <td className={CELL}><Bar share={largest > 0 ? index.sizeBytes / largest : 0} over={flag !== undefined} /></td>
      <td className={NUM}>{formatBytes(index.sizeBytes)}</td>
      <td className={NUM}>{formatCount(scans)}</td>
      <td className={CELL}>{tag === undefined ? null : <Tag>{tag}</Tag>}</td>
    </tr>
  );
}

/** The ceiling as its type's name where it is one: the bigint maximum is not a number JavaScript can print. */
function limitOf(s: SequenceEntry): string {
  if (s.maxValue > Number.MAX_SAFE_INTEGER) return 'bigint';
  if (s.maxValue === 2147483647) return 'integer';
  if (s.maxValue === 32767) return 'smallint';
  return formatCount(s.maxValue);
}

/** Sequence and what owns it · a bar against the limit of its type · where it is · tagged near its limit. */
export function SequenceRow({ sequence }: { sequence: SequenceEntry }) {
  const near = sequence.pctUsed !== null && sequence.pctUsed >= NEAR_LIMIT_PCT;
  return (
    <tr>
      <td className={CELL}>
        <span className={NAME}>{sequence.name}</span>{' '}
        <span className={QUIET}>{sequence.column === null ? 'unowned' : `${sequence.column} ${sequence.columnType ?? ''}`.trim()}</span>
      </td>
      <td className={cn(CELL, 'w-1/2')}>
        {/* Could not look is a hollow ring, never an empty bar: an empty bar is 0 %. */}
        {sequence.pctUsed === null
          ? <i aria-hidden className="inline-block size-2 rounded-full align-middle shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" />
          : <Bar share={Math.max(0.005, sequence.pctUsed / 100)} over={near} />}
      </td>
      <td className={NUM}>
        {sequence.lastValue === null
          ? <span className="font-sans text-muted-foreground">not readable by this role</span>
          : `${formatCount(sequence.lastValue)} of ${limitOf(sequence)}`}
      </td>
      <td className={CELL}>{near ? <Tag>near its limit</Tag> : null}</td>
    </tr>
  );
}

/** What a population's rows are: when they were read, what the cap left out, and what could not be read. */
export function CatalogNote({ at, failed, shown, total, what }: {
  at: number | null; failed: readonly { message: string }[]; shown: number; total: number | null; what: string;
}) {
  return (
    <p className="my-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
      {failed.length === 0 ? null : (
        <span className="flex items-center gap-2">
          <i aria-hidden className="size-2 flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]" />
          could not be read: {failed[0]!.message}
        </span>
      )}
      {at === null ? null : <span>as of <Time at={at} /></span>}
      {total !== null && total > shown ? <span>the {formatCount(shown)} largest of {formatCount(total)} {what}</span> : null}
    </p>
  );
}
