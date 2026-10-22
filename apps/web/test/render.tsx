import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';

/**
 * A local stand-in for @testing-library/react, kept deliberately: it is small,
 * has no dependency behind it, and every test in this app is written against
 * it. guards.test.ts ("the web manifest") keeps that package uninstalled.
 */
export interface Rendered {
  container: HTMLElement;
  text: () => string;
  find: (pattern: string | RegExp) => HTMLElement | null;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => void;
}

export async function render(element: ReactElement): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    text: () => container.textContent ?? '',
    find: (pattern) => {
      const re = typeof pattern === 'string' ? null : pattern;
      const all = Array.from(container.querySelectorAll<HTMLElement>('*'));
      return all.find((el) => {
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('');
        return re ? re.test(own) : own.includes(pattern as string);
      }) ?? null;
    },
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}
