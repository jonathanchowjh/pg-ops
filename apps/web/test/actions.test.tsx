import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';
import { ConfirmAction, KillButton } from '@/components/actions';

// react-dom warns "not configured to support act(...)" when a concurrent
// update commits with this global unset and no `act()` on the stack. `send`'s
// `startTransition` resumes after `await fetch(...)`, once `click()`'s own
// `act()` scope has exited, so it needs this flag rather than a bigger scope.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }));

const PROPS = { database: 'primary', pid: 42, backendStart: '2026-01-01T00:00:00Z' };

/**
 * `render` wraps only the initial render in `act`; a click that causes a
 * state update must be wrapped by the caller, or the DOM read races the
 * re-render.
 */
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

/**
 * `send`'s `await fetch(...)` and `await res.json()` resolve after `click()`'s
 * `act()` scope has exited; one more empty `act` tick gives them a scope.
 */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/**
 * React tracks the last value it set on the node, so assigning `.value`
 * directly and firing `input` is ignored. The native setter is what a
 * controlled component observes.
 */
const typeReason = (container: HTMLElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const input = container.querySelector<HTMLInputElement>('input')!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); refresh.mockClear(); });

describe('KillButton', () => {
  it('is the page\'s one danger button when it is the answer\'s action', async () => {
    const { container } = await render(<KillButton prominent {...PROPS} />);
    expect(container.querySelector('button')!.className).toContain('border-critical-ink');
  });

  /**
   * jsdom computes no layout, so this locks the classes that keep the armed
   * panel on a 390px screen. The width cap alone would clip the contents, and
   * `flex-wrap` alone would not narrow a panel sized to its content. The cap
   * is only safe while `right-2` anchors the panel to the cell's right edge.
   */
  it('keeps the armed panel inside a phone viewport', async () => {
    const { container } = await render(<KillButton {...PROPS} />);
    await click(container.querySelector('button'));
    const panel = container.querySelector('button[data-confirm]')!.parentElement!;
    expect(panel.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(panel.className).toContain('flex-wrap');
    expect(panel.className).toContain('right-2');
    // Both halves are released above `sm`: without these the panel wraps at
    // the ~190px action cell on every screen.
    expect(panel.className).toContain('sm:flex-nowrap');
    expect(panel.className).toContain('sm:max-w-none');
  });

  /**
   * The pre-click assertions distinguish "asks first" from "always open, but
   * refuses an empty reason", which the post-click ones alone cannot.
   */
  it('does not send anything on the first click — it asks first', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container, text } = await render(<KillButton {...PROPS} />);

    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(text()).toContain('Terminate');
    expect(text()).not.toContain('Confirm');

    await click(container.querySelector('button'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('input')).not.toBeNull();
    expect(text()).toContain('Confirm');
  });

  it('refuses to send with an empty reason', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await click(container.querySelector('button[data-confirm]'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The identity the page rendered is the one sent; otherwise killBackend's
   * PID-reuse guard would not compare against what the operator saw.
   */
  it('sends the pid and the backendStart it was given, with the typed reason', async () => {
    // Typed as `typeof fetch` so `mock.calls[0]` below is `[url, init]`, not `[]`.
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ outcome: 'terminated' })));
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));

    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      // The native setter, for the reason given at `typeReason`.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'blocking checkout');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/db/primary/kill');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      pid: 42,
      backendStart: '2026-01-01T00:00:00Z',
      reason: 'blocking checkout',
    });
  });

  it('reports a refusal in the operator\'s words, not the protocol\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ outcome: 'session-changed' }))));
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const input = container.querySelector<HTMLInputElement>('input')!;
      setter.call(input, 'why not');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(text()).toContain('different session');
  });

  /**
   * A failed pg_terminate_backend (typically a role lacking
   * pg_signal_backend) arrives as a 502 with a JSON `error`, not an
   * `outcome`; `send` must fall back to `body.error`.
   */
  it('surfaces a 502 error body to the operator, not a blank or a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'permission denied for function pg_terminate_backend' }),
        { status: 502 },
      )));
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const input = container.querySelector<HTMLInputElement>('input')!;
      setter.call(input, 'why not');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(text()).toContain('permission denied for function pg_terminate_backend');
  });

  /**
   * `router.refresh()` does not remount a same-keyed table row, so the
   * control must come back by itself after 'session-changed' or an error.
   */
  it('lets a refused kill be retried without navigating away', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ outcome: 'session-changed' })));
    vi.stubGlobal('fetch', fetchSpy);
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await typeReason(container, 'first try');
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    // The outcome is still reported, with the control actionable beside it.
    expect(text()).toContain('different session');
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toContain('Terminate');

    await click(retry);
    await typeReason(container, 'second try');
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).reason)
      .toBe('second try');
  });

  /**
   * 'terminated' is terminal: a second Terminate button would invite a kill
   * against a pid Postgres may already have handed to someone else.
   */
  it('does not offer a retry after a successful termination', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ outcome: 'terminated' }))));
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await typeReason(container, 'blocking checkout');
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(text()).toContain('terminated');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  /**
   * `fetch` itself can reject (offline, DNS, an aborted connection). Uncaught,
   * the rejection leaves `pending` set and no outcome shown.
   */
  it('surfaces a network failure when fetch itself rejects, not silence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    const { container, text } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const input = container.querySelector<HTMLInputElement>('input')!;
      setter.call(input, 'why not');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('button[data-confirm]'));
    await settle();

    expect(text()).toContain('Failed to fetch');
  });
});

const fetchOk = (body: unknown = { ok: true }, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

const open = async (r: Awaited<ReturnType<typeof render>>, label: string) => {
  const button = [...r.container.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => { button.click(); });
};
const confirmButton = (r: Awaited<ReturnType<typeof render>>) =>
  r.container.querySelector('button[data-confirm]') as HTMLButtonElement;
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ConfirmAction', () => {
  it('asks before it acts, rather than firing on the first click', async () => {
    const f = fetchOk();
    const r = await render(<ConfirmAction label="Analyze" endpoint="/api/db/prod/analyze" />);
    await open(r, 'Analyze');
    expect(f).not.toHaveBeenCalled();
    expect(confirmButton(r)).not.toBeNull();
    r.unmount();
  });

  it('keeps Confirm disabled until a reason is given', async () => {
    const r = await render(<ConfirmAction label="Analyze" endpoint="/api/db/prod/analyze" />);
    await open(r, 'Analyze');
    expect(confirmButton(r).disabled).toBe(true);
    await type(r.container.querySelector('input')!, 'because');
    expect(confirmButton(r).disabled).toBe(false);
    r.unmount();
  });

  /** Tier 2. openAction re-checks the same string server-side. */
  it('keeps Confirm disabled until the typed confirmation matches exactly', async () => {
    const r = await render(
      <ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats" confirmWith="prod" />);
    await open(r, 'Reset');
    const [reason, typedField] = [...r.container.querySelectorAll('input')] as HTMLInputElement[];
    await type(reason!, 'because');
    expect(confirmButton(r).disabled).toBe(true);

    // A near-miss is not a confirmation.
    await type(typedField!, 'PROD');
    expect(confirmButton(r).disabled).toBe(true);

    await type(typedField!, 'prod');
    expect(confirmButton(r).disabled).toBe(false);
    r.unmount();
  });

  it('posts the reason and the confirmation it was given', async () => {
    const f = fetchOk();
    const r = await render(
      <ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats" confirmWith="prod" />);
    await open(r, 'Reset');
    const [reason, typedField] = [...r.container.querySelectorAll('input')] as HTMLInputElement[];
    await type(reason!, '  spaced  ');
    await type(typedField!, 'prod');
    await act(async () => { confirmButton(r).click(); });

    expect(f).toHaveBeenCalledOnce();
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ reason: 'spaced', confirm: 'prod' });
    r.unmount();
  });

  it('merges the extra body fields it was given', async () => {
    const f = fetchOk();
    const r = await render(
      <ConfirmAction label="Kill" endpoint="/api/db/prod/kill-long-running"
        body={{ targets: [{ pid: 7, backendStart: null }] }} confirmWith="prod" />);
    await open(r, 'Kill');
    const [reason, typedField] = [...r.container.querySelectorAll('input')] as HTMLInputElement[];
    await type(reason!, 'because');
    await type(typedField!, 'prod');
    await act(async () => { confirmButton(r).click(); });

    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.targets).toEqual([{ pid: 7, backendStart: null }]);
    r.unmount();
  });

  /** The 502 body's `error` is the only place the real reason reaches the operator. */
  it('shows the error from the body rather than the status code', async () => {
    fetchOk({ error: 'permission denied for function pg_stat_reset' }, 502);
    const r = await render(<ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats" />);
    await open(r, 'Reset');
    await type(r.container.querySelector('input')!, 'because');
    await act(async () => { confirmButton(r).click(); });

    expect(r.text()).toContain('permission denied');
    expect(r.text()).not.toContain('HTTP 502');
    r.unmount();
  });

  /**
   * The outcome sentence is chosen by key, because a function cannot cross
   * from a server page into a client component (see OUTCOMES).
   */
  it.each([
    ['kill-batch', { results: [{ outcome: 'terminated' }, { outcome: 'terminated' }, { outcome: 'session-changed' }] }, '2 of 3 terminated.'],
    ['analyze', { results: [{ ok: true }, { ok: true }, { ok: false }] }, '2 of 3 analyzed.'],
    ['analyze', { results: [{ ok: false, relation: 'public.users', error: 'canceling statement due to lock timeout' }] },
      '0 of 1 analyzed. public.users: canceling statement due to lock timeout.'],
  ] as const)('turns a %s result into its sentence', async (key, body, sentence) => {
    fetchOk(body);
    const r = await render(<ConfirmAction label="Go" endpoint="/api/db/prod/x" describe={key} />);
    await open(r, 'Go');
    await type(r.container.querySelector('input')!, 'because');
    await act(async () => { confirmButton(r).click(); });

    expect(r.text()).toContain(sentence);
    r.unmount();
  });

  /** Left uncaught, the rejection escapes the transition and `pending` never clears. */
  it('survives fetch rejecting, and says what happened', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const r = await render(<ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats" />);
    await open(r, 'Reset');
    await type(r.container.querySelector('input')!, 'because');
    await act(async () => { confirmButton(r).click(); });

    expect(r.text()).toContain('network down');
    r.unmount();
  });

  it('refreshes the page so the operator sees the new state', async () => {
    fetchOk();
    const r = await render(<ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats" />);
    await open(r, 'Reset');
    await type(r.container.querySelector('input')!, 'because');
    await act(async () => { confirmButton(r).click(); });

    expect(refresh).toHaveBeenCalled();
    r.unmount();
  });

  it('states what is irreversible before the operator commits', async () => {
    const r = await render(
      <ConfirmAction label="Reset" endpoint="/api/db/prod/reset-stats"
        danger="This clears every table and index statistic for this database." />);
    await open(r, 'Reset');
    expect(r.text()).toContain('clears every table and index statistic');
    r.unmount();
  });
});
