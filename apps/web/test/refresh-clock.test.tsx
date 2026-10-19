import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import { Clock } from '@/components/clock';
import { Refresh } from '@/components/refresh';
import { gridFor } from '@/lib/clock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const NOW = Date.UTC(2026, 9, 12, 8, 30, 0);
let view: Rendered;
const mount = async () => {
  view = await render(
    <Clock grid={gridFor({ win: '900' }, NOW)} now={NOW} day={{ to: NOW, columns: [] }} events={[]}>
      <Refresh intervalMs={5_000} />
    </Clock>,
  );
};
const tickOnce = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); };

beforeEach(() => { vi.useFakeTimers(); router.refresh.mockClear(); });
afterEach(() => { view.unmount(); vi.useRealTimers(); Object.defineProperty(window, 'scrollY', { value: 0, configurable: true }); });

describe('<Refresh> under a clock', () => {
  it('polls while the page is live', async () => {
    await mount();
    await tickOnce();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while the page is pinned to a moment, and resumes at live', async () => {
    await mount();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); });
    await tickOnce();
    await tickOnce();
    expect(router.refresh).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await tickOnce();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when the reader has scrolled down the tree', async () => {
    await mount();
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    await tickOnce();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('prints no age: the clock bar says what moment the page shows', async () => {
    await mount();
    await tickOnce();
    expect(view.text()).not.toMatch(/ago|updated/);
    expect([...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Refresh')).toBe(true);
  });
});
