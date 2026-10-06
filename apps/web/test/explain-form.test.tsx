import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';
import { ExplainForm } from '@/components/explain-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.restoreAllMocks(); });

const respond = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const setup = async () => {
  const r = await render(<ExplainForm name="prod" />);
  const textarea = r.container.querySelector('textarea')!;
  const button = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Explain')!;
  const submit = async () => { await act(async () => { button.click(); }); };
  return { r, textarea, button, submit };
};

const PLAN = {
  'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public', Alias: 'orders',
  'Startup Cost': 0, 'Total Cost': 2400, 'Plan Rows': 5, 'Plan Width': 33, Filter: '(orders.customer_id = 42)',
};

describe('ExplainForm', () => {
  it('will not explain nothing', async () => {
    const f = respond({});
    const { button, submit } = await setup();
    expect(button.disabled).toBe(true);
    await submit();
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the statement as JSON to the database it names', async () => {
    const f = respond({ ok: true, data: { plan: PLAN, parameters: 0, advice: [] }, verdict: null, measuredAt: 0 });
    const { textarea, submit } = await setup();
    await type(textarea, 'SELECT * FROM orders WHERE customer_id = 42');
    await submit();
    expect(f).toHaveBeenCalledWith('/api/db/prod/explain', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM orders WHERE customer_id = 42' }),
    }));
  });

  it('renders the plan as EXPLAIN text, and the statement each suggestion hands over', async () => {
    respond({
      ok: true, verdict: null, measuredAt: 0,
      data: {
        plan: PLAN, parameters: 0,
        advice: [{
          schema: 'public', table: 'orders', found: true, rowProgression: [100000, 20],
          suggestion: { schema: 'public', table: 'orders', using: 'btree', columns: ['customer_id'],
            statement: 'CREATE INDEX CONCURRENTLY ON "public"."orders" ("customer_id")' },
        }],
      },
    });
    const { r, textarea, submit } = await setup();
    await type(textarea, 'SELECT 1');
    await submit();
    expect(r.text()).toContain('Seq Scan on public.orders  (cost=0.00..2400.00 rows=5 width=33)');
    expect(r.text()).toContain('Filter: (orders.customer_id = 42)');
    expect(r.text()).toContain('CREATE INDEX CONCURRENTLY ON "public"."orders" ("customer_id")');
    expect(r.text()).not.toContain('Generic plan');
  });

  it('says when the plan is generic, so its estimates are not read as a bound value\'s', async () => {
    respond({ ok: true, verdict: null, measuredAt: 0, data: { plan: PLAN, parameters: 2, advice: [] } });
    const { r, textarea, submit } = await setup();
    await type(textarea, 'SELECT * FROM orders WHERE customer_id = $1 AND status = $2');
    await submit();
    expect(r.text()).toContain('Generic plan: $1–$2 were planned without values.');
  });

  it('renders a failed plan as the panel renders any failure', async () => {
    respond({ ok: false, reason: 'error', message: 'relation "nope" does not exist' });
    const { r, textarea, submit } = await setup();
    await type(textarea, 'SELECT * FROM nope');
    await submit();
    expect(r.text()).toContain('Unavailable — error');
    expect(r.text()).toContain('relation "nope" does not exist');
  });

  it('renders a refused request by its error', async () => {
    respond({ error: 'sql is limited to 10000 characters.' }, 400);
    const { r, textarea, submit } = await setup();
    await type(textarea, 'SELECT 1');
    await submit();
    expect(r.text()).toContain('sql is limited to 10000 characters.');
  });

  it('says so when fetch itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));
    const { r, textarea, submit } = await setup();
    await type(textarea, 'SELECT 1');
    await submit();
    expect(r.text()).toContain('Failed to fetch');
  });
});

/**
 * A9's receiving half. The handoff is read AFTER mount, not as the initial
 * state: this is a client component inside a server-rendered page, so an
 * initial-state read would make the server's render and the first client
 * render disagree and trip hydration.
 *
 * It is also CLEARED on read. The key is a one-shot handoff, not a draft —
 * left in place, every later visit to this page would silently replace
 * whatever the operator had typed with a statement they clicked once.
 */
describe('ExplainForm — the handoff from a query row', () => {
  it('starts with the handed-off statement and clears the handoff', async () => {
    sessionStorage.setItem('pgops.explain', 'SELECT 2');
    const r = await render(<ExplainForm name="prod" />);
    expect((r.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('SELECT 2');
    expect(sessionStorage.getItem('pgops.explain')).toBeNull();
    r.unmount();
  });

  it('starts empty when nothing was handed over', async () => {
    sessionStorage.clear();
    const r = await render(<ExplainForm name="prod" />);
    expect((r.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    r.unmount();
  });

  it('renders rather than throwing when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const r = await render(<ExplainForm name="prod" />);
    expect(r.container.querySelector('textarea')).not.toBeNull();
    r.unmount();
  });
});
