import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import { ExplainLink, EXPLAIN_HANDOFF_KEY } from '@/components/explain-link';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: () => {} }) }));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  sessionStorage.clear();
  push.mockClear();
  vi.restoreAllMocks();
});

const click = async (r: Rendered) => {
  await act(async () => { r.container.querySelector('button')!.click(); });
};

describe('ExplainLink', () => {
  /**
   * The statement travels through `sessionStorage`, never the URL. That is
   * the explain route's own rule — a statement is a POST body, because it
   * can carry a literal secret — and a query string would put it in history,
   * in the server log and in any referrer.
   */
  it('hands the statement over through sessionStorage, never the URL', async () => {
    rendered = await render(<ExplainLink name="prod" statement="SELECT * FROM t WHERE id = $1" />);
    await click(rendered);
    expect(sessionStorage.getItem(EXPLAIN_HANDOFF_KEY)).toBe('SELECT * FROM t WHERE id = $1');
    expect(push).toHaveBeenCalledWith('/db/prod/queries/explain');
    // The statement reaches the destination in storage and in nothing else.
    expect(push.mock.calls[0]![0]).not.toContain('SELECT');
  });

  /**
   * A private window, or blocked site data, makes every `sessionStorage`
   * call throw. Landing nowhere is the worst outcome; landing on an empty
   * form is the same place the operator was before this link existed.
   */
  it('still navigates when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    rendered = await render(<ExplainLink name="prod" statement="SELECT 1" />);
    await click(rendered);
    expect(push).toHaveBeenCalledWith('/db/prod/queries/explain');
  });

  it('carries the database name into the path it navigates to', async () => {
    rendered = await render(<ExplainLink name="staging" statement="SELECT 1" />);
    await click(rendered);
    expect(push).toHaveBeenCalledWith('/db/staging/queries/explain');
  });
});
