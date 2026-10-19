import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexRead, SequenceEntry, TableRead } from '@pgops/checks';
import { render, type Rendered } from './render';
import { IndexRow, SequenceRow, TableFactRow } from '@/components/catalog-rows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let view: Rendered;
afterEach(() => { view.unmount(); });
const row = async (el: ReactElement): Promise<void> => { view = await render(<table><tbody>{el}</tbody></table>); };
const fill = () => view.container.querySelector<HTMLElement>('[data-bar] i');

const seq = (over: Partial<SequenceEntry> = {}): SequenceEntry => ({
  name: 'public.events_id_seq', table: 'public.events', column: 'id', columnType: 'integer',
  maxValue: 2147483647, lastValue: 1_932_735_283, pctUsed: 90, readable: true, ...over,
});

describe('a sequence row', () => {
  it('is a bar against the limit of its column\'s type, tagged from ninety per cent', async () => {
    await row(<SequenceRow sequence={seq()} />);
    expect(view.text()).toContain('1,932,735,283 of integer');
    expect(view.text()).toContain('near its limit');
    expect(fill()!.style.width).toBe('90%');
  });

  // Review Focus 5.
  it('measures an unowned sequence against its own maximum, and says it has no owner', async () => {
    await row(<SequenceRow sequence={seq({ table: null, column: null, columnType: null, maxValue: 1000, lastValue: 10, pctUsed: 1 })} />);
    expect(view.text()).toContain('unowned');
    expect(view.text()).toContain('10 of 1,000');
    expect(view.text()).not.toContain('near its limit');
  });

  // Review Focus 5.
  it('draws no bar for a sequence this role cannot read: that is not 0 %', async () => {
    await row(<SequenceRow sequence={seq({ lastValue: null, pctUsed: null, readable: false })} />);
    expect(fill()).toBeNull();
    expect(view.text()).toContain('not readable by this role');
  });

  it('names the bigint ceiling, which is not a number JavaScript can print', async () => {
    await row(<SequenceRow sequence={seq({ table: null, column: null, columnType: null, maxValue: 9223372036854776000, lastValue: 5, pctUsed: 0 })} />);
    expect(view.text()).toContain('5 of bigint');
  });
});

const index = (over: Partial<IndexRead> = {}): IndexRead => ({
  name: 'public.orders_status', table: 'public.orders', columns: 'status, note', sizeBytes: 4096, scans: 0, hitRate: null,
  unique: false, primary: false, valid: true, duplicateOf: null, ...over,
});

describe('an index row', () => {
  it('prints its columns, its size against the largest, and the scans it is given', async () => {
    await row(<IndexRow database="prod" index={index()} largest={8192} scans={12} />);
    expect(view.text()).toContain('public.orders_status (status, note)');
    expect(view.text()).toContain('4 KB');
    expect(view.text()).toContain('12');
    expect(fill()!.style.width).toBe('50%');
  });

  it('says never used, or what already covers it', async () => {
    await row(<IndexRow database="prod" index={index()} largest={1} scans={0} />);
    expect(view.text()).toContain('never used');
    view.unmount();
    await row(<IndexRow database="prod" index={index({ duplicateOf: 'public.orders_status_note', scans: 3 })} largest={1} scans={3} />);
    expect(view.text()).toContain('duplicate of orders_status_note');
  });

  it('tags nothing on a primary key nobody scans', async () => {
    await row(<IndexRow database="prod" index={index({ unique: true, primary: true })} largest={1} scans={0} />);
    expect(view.text()).not.toContain('never used');
  });

  it('links to its table only where the list is not that table\'s own', async () => {
    await row(<IndexRow database="prod" index={index()} largest={1} scans={0} />);
    expect(view.container.querySelector('a')).toBeNull();
    view.unmount();
    await row(<IndexRow database="prod" index={index()} largest={1} scans={0} withTable />);
    expect(view.container.querySelector('a')!.getAttribute('href')).toBe('/db/prod/tables/public.orders');
  });
});

const table = (over: Partial<TableRead> = {}): TableRead => ({
  name: 'public.users', kind: 'table', sizeBytes: 2048, heapBytes: 1024, indexBytes: 1024, liveRows: 1200, deadRows: 30,
  vacuumTrigger: 60, inserted: 0, updated: 0, deleted: 0, seqScans: 0, seqRows: 0, idxScans: 0, idxRows: 0, hitRate: null,
  lastVacuum: Date.UTC(2026, 9, 12, 8, 0, 0), lastAnalyze: null, xidAge: 1, indexes: 1, unvalidated: 0, vacuuming: null, ...over,
});

describe('a table row', () => {
  it('is one link to the table, its numbers, and its dead rows against the trigger', async () => {
    await row(<TableFactRow database="prod" table={table()} freezeMaxAge={2e8} />);
    const links = [...view.container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/db/prod/tables/public.users']);
    expect(view.text()).toContain('1,200');
    expect(view.text()).toContain('2 KB');
    expect(fill()!.style.width).toBe('50%');
    expect(view.container.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-12T08:00:00.000Z');
  });

  it('fills the bar and no further past the trigger, and says overdue', async () => {
    await row(<TableFactRow database="prod" table={table({ deadRows: 600 })} freezeMaxAge={2e8} />);
    expect(fill()!.style.width).toBe('100%');
    expect(view.text()).toContain('vacuum overdue');
  });

  it('shows two tags at most, the most urgent', async () => {
    await row(<TableFactRow database="prod" table={table({ deadRows: 600, xidAge: 3e8, unvalidated: 1 })} freezeMaxAge={2e8} />);
    expect(view.text()).toContain('vacuum overdue');
    expect(view.text()).toContain('xid age');
    expect(view.text()).not.toContain('not validated');
  });

  it('says never vacuumed with a dash, not a time', async () => {
    await row(<TableFactRow database="prod" table={table({ lastVacuum: null })} freezeMaxAge={null} />);
    expect(view.container.querySelector('time')).toBeNull();
  });
});
