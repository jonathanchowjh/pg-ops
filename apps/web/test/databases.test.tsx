import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { Databases } from '@/components/databases';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }));

// jsdom has <dialog> but not its methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
});

const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (v: Rendered, label: string) =>
  [...v.container.querySelectorAll('button')].find((b) => b.textContent === label);

/** Answers each fetch in turn and records what was sent. */
function server(...answers: [number, unknown][]) {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent.push({ method: init.method!, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const [status, body] = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  }));
  return sent;
}

const READ_ONLY = { identity: 'app · pgops · PG 17.2 · SSL', readOnly: true };
let view: Rendered;
const mount = async (props: Partial<Parameters<typeof Databases>[0]> = {}) => {
  view = await render(<Databases databases={[]} actionsOn={false} savedTo="/home/node/.pgops/databases.json" {...props} />);
};
const fill = async (name: string, url: string) => {
  const [n, u] = [...view.container.querySelectorAll('input')];
  await type(n!, name);
  await type(u!, url);
};

afterEach(() => { view.unmount(); vi.unstubAllGlobals(); refresh.mockClear(); });

describe('Databases', () => {
  it('opens from "Add a database" when there is none, and from "Databases" otherwise', async () => {
    await mount();
    await click(button(view, 'Add a database'));
    expect(view.container.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(view.container.querySelector('input'));
    view.unmount();
    await mount({ databases: [{ name: 'prod', source: 'env' }] });
    expect(button(view, 'Databases')).toBeDefined();
  });

  /** Test is not Add: the operator reads what the server said, then confirms. */
  it('tests first, shows the server saying read only, and adds only on the second click', async () => {
    const sent = server([200, READ_ONLY], [201, READ_ONLY]);
    await mount();
    await click(button(view, 'Add a database'));
    await fill('prod', 'postgres://u:p@h/app');
    await click(button(view, 'Test connection'));
    await settle();
    expect(sent).toEqual([{ method: 'POST', body: { name: 'prod', url: 'postgres://u:p@h/app', save: false } }]);
    expect(view.text()).toContain('app · pgops · PG 17.2 · SSL');
    expect(view.text()).toContain('transaction_read_only = on');
    expect(view.text()).toContain('Actions are off');

    await click(button(view, 'Add prod'));
    await settle();
    expect(sent[1]).toEqual({ method: 'POST', body: { name: 'prod', url: 'postgres://u:p@h/app', save: true } });
    expect(refresh).toHaveBeenCalled();
    expect(view.container.querySelector('dialog')!.open).toBe(false);
  });

  it('says what actions can do there when they are on', async () => {
    server([200, READ_ONLY]);
    await mount({ actionsOn: true });
    await fill('prod', 'postgres://h/app');
    await click(button(view, 'Test connection'));
    await settle();
    expect(view.text()).toContain('Actions are on');
  });

  /** A test answers for the URL it ran on. */
  it('voids the test when the name or URL is edited', async () => {
    server([200, READ_ONLY]);
    await mount();
    await fill('prod', 'postgres://h/app');
    await click(button(view, 'Test connection'));
    await settle();
    expect(button(view, 'Add prod')).toBeDefined();
    await type(view.container.querySelectorAll('input')[1]!, 'postgres://h/other');
    expect(button(view, 'Add prod')).toBeUndefined();
  });

  it('offers no Add when the server did not keep the session read only', async () => {
    server([200, { ...READ_ONLY, readOnly: false }]);
    await mount();
    await fill('prod', 'postgres://h/app');
    await click(button(view, 'Test connection'));
    await settle();
    expect(view.text()).toContain('did not keep');
    expect(button(view, 'Add prod')).toBeUndefined();
  });

  it('shows why a test failed', async () => {
    server([422, { error: 'Could not connect: connect ECONNREFUSED 127.0.0.1:5432' }]);
    await mount();
    await fill('prod', 'postgres://h/app');
    await click(button(view, 'Test connection'));
    await settle();
    expect(view.container.querySelector('[role=alert]')!.textContent).toContain('ECONNREFUSED');
  });

  it('removes a saved database after asking, and offers no Remove on one set in the environment', async () => {
    const sent = server([200, { name: 'eu' }]);
    await mount({ databases: [{ name: 'prod', source: 'env' }, { name: 'eu', source: 'saved' }] });
    expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['prodset in the environment', 'euRemove']);
    await click(button(view, 'Remove'));
    await click(button(view, 'Remove eu'));
    await settle();
    expect(sent).toEqual([{ method: 'DELETE', body: { name: 'eu' } }]);
    expect(refresh).toHaveBeenCalled();
  });
});
