import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';
import { KillButton } from '@/components/kill-button';

// react-dom's `isConcurrentActEnvironment` (react-dom-client.development.js)
// warns "not configured to support act(...)" whenever a concurrent update —
// here, `send`'s `startTransition` resuming after `await fetch(...)` —
// commits while this global is unset AND no `act()` call is currently on the
// stack. `send`'s continuation runs on a later microtask, after `click()`'s
// own `act()` scope has already exited, so it needs this flag rather than a
// bigger act scope. No other test in this suite uses a transition, which is
// why this is the first file that needs it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const PROPS = { database: 'primary', pid: 42, backendStart: '2026-01-01T00:00:00Z' };

/**
 * `render` is async and wraps only the INITIAL render in `act`; a click that
 * causes a state update has to be wrapped by the caller, or React 19 warns and
 * the DOM read below races the re-render. `find()` in that helper matches an
 * element's own TEXT, not a CSS selector — `querySelector` is the right tool
 * for reaching a specific control.
 */
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

/**
 * `send` runs inside `startTransition`, so its `await fetch(...)` and
 * `await res.json()` resolve on microtasks after `click()`'s own `act()`
 * scope has already exited — React then flushes the resulting `setOutcome`
 * update outside any `act()`, which is exactly the "not configured to
 * support act" warning. One more empty `act` tick gives those microtasks a
 * scope to resolve inside.
 */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/**
 * React tracks the last value it set on the node, so assigning `.value`
 * directly and firing `input` is ignored as a no-op change. The native setter
 * is what a controlled component actually observes — the same mechanism
 * testing-library's `fireEvent.change` uses internally.
 */
const typeReason = (container: HTMLElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const input = container.querySelector<HTMLInputElement>('input')!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(() => vi.unstubAllGlobals());

describe('KillButton', () => {
  /**
   * I2 (review): the original version of this test clicked immediately and
   * asserted only the POST-click state, which the empty-reason guard in
   * `send()` satisfies all on its own — flipping the component's initial
   * `confirming` state to `true` (i.e. deleting the two-step gate entirely)
   * left every assertion here green. The pre-click assertions below are
   * what actually distinguish "asks first" from "always open, but refuses
   * an empty reason": before any click there must be no reason input and no
   * Confirm/Cancel at all, only a single "Terminate" button.
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
   * The identity the page rendered is the identity that gets sent. Re-deriving
   * it here — or omitting it and letting the server look it up — would turn
   * killBackend's single-statement PID-reuse guard into a guard against
   * nothing, because the value it compares would no longer be the one the
   * human was looking at when they decided.
   */
  it('sends the pid and the backendStart it was given, with the typed reason', async () => {
    // Typed as `typeof fetch` (rather than left to infer from the zero-arg
    // implementation) so `mock.calls[0]` below is `[url, init]`, not `[]` —
    // a function with fewer params than its declared type is a valid
    // implementation; TS just needs the declared type to index the tuple.
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ outcome: 'terminated' })));
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = await render(<KillButton {...PROPS} />);

    await click(container.querySelector('button'));

    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      // React tracks the last value it set on the node, so assigning `.value`
      // directly and firing `input` is ignored as a no-op change. The native
      // setter is what a controlled component actually observes — the same
      // mechanism testing-library's `fireEvent.change` uses internally.
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
   * C1: a failed pg_terminate_backend (typically the console's role lacking
   * pg_signal_backend) now surfaces as a 502 with a JSON `error`, not an
   * `outcome`. This is the message an on-call engineer most needs to read —
   * it names a fixable privilege problem — so the fallback chain in `send`
   * (`body.outcome ?? body.error ?? ...`) must not collapse to `body.outcome`
   * alone, or this text goes missing exactly when it matters most.
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
   * F6 (final review): a refused kill could not be retried. `router.refresh()`
   * does not remount a same-keyed table row, so once `outcome` was set the
   * control was permanently replaced by text — and the two outcomes an
   * operator most wants to retry are exactly the ones that left it dead:
   * 'session-changed' (the guard refused because the row was stale, so the
   * refreshed row is the one they now want to act on) and any error. On the
   * incident path of an incident tool, the only way back was to navigate
   * away.
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

    // The outcome is still reported — the operator has to be able to read why
    // it was refused — but the control is actionable again alongside it.
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
   * The other half, and the reason this is not just "always allow a retry":
   * 'terminated' is genuinely terminal. The backend is gone; a second
   * Terminate button on the same row invites a kill against a pid Postgres
   * may already have handed to someone else, which is the exact hazard the
   * PID-reuse guard exists for. Left as it was.
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
   * I3 (review): `fetch` itself can reject — offline, DNS, an aborted
   * connection — which is exactly the kind of failure this control exists
   * to survive, since it is the shape of failure most likely during a real
   * incident. Before the fix, `send` had no `try`/`catch` around the
   * `fetch`/`res.json()` pair: a rejection propagated out of the
   * `startTransition` callback, `pending` never returned to false, no
   * outcome was ever set, and the operator saw nothing at all — silently
   * defeating C1's whole point of surfacing why a kill failed.
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
