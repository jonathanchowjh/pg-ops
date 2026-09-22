import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';
import { ConfirmAction } from '@/components/confirm-action';

// See kill-button.test.tsx: `send`'s startTransition resumes after `await
// fetch(...)`, on a later microtask than the click's own act() scope, so the
// flag is needed rather than a bigger scope.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }));

afterEach(() => { vi.restoreAllMocks(); refresh.mockClear(); });

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

  /**
   * Tier 2. The disabled state is for the operator; openAction re-checks the
   * same string server-side, because a confirmation the client alone enforces
   * is one curl away from bypassed.
   */
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

  /**
   * The 502 path carries `error`, and it is the only place the real reason —
   * typically a missing privilege — reaches the operator. A generic
   * "HTTP 502" would replace the one message they need.
   */
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
   * The outcome sentence is chosen by key, not passed as a function: the
   * callers are server pages and a function cannot cross into a client
   * component (see OUTCOMES). These pin what each key says, since the two
   * closures they replaced were the only place those sentences were written.
   */
  it.each([
    ['kill-batch', { results: [{ outcome: 'terminated' }, { outcome: 'terminated' }, { outcome: 'session-changed' }] }, '2 of 3 terminated.'],
    ['analyze', { results: [{ ok: true }, { ok: true }, { ok: false }] }, '2 of 3 analyzed.'],
  ] as const)('turns a %s result into its sentence', async (key, body, sentence) => {
    fetchOk(body);
    const r = await render(<ConfirmAction label="Go" endpoint="/api/db/prod/x" describe={key} />);
    await open(r, 'Go');
    await type(r.container.querySelector('input')!, 'because');
    await act(async () => { confirmButton(r).click(); });

    expect(r.text()).toContain(sentence);
    r.unmount();
  });

  /**
   * fetch itself can reject — offline, DNS, an aborted connection. Left
   * uncaught the rejection escapes the transition, `pending` never clears,
   * and the operator sees nothing at all.
   */
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
