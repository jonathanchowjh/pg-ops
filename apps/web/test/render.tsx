import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';

/**
 * A local stand-in for @testing-library/react.
 *
 * Originally not a preference but a necessity: while two react majors
 * coexisted, that package hoisted to the repo ROOT, next to the Ink TUI's
 * react 18, so its own `require('react')` found 18 while the component under
 * test was 19. Every render failed with "Objects are not valid as a React
 * child", an error naming neither the library nor a version. Aliasing,
 * deduping and inlining all failed because the hoisting was physical, not a
 * resolution preference. `react-dom/client` used directly never had that
 * problem: it is the app's own copy, resolved from apps/web.
 *
 * P1b deleted the TUI, so that hazard is historical — @testing-library/react
 * would resolve correctly today. This file stays regardless, and the
 * decision was taken deliberately rather than by default: it has worked for
 * a phase, it is ~25 lines with no dependency behind it, and every test in
 * this app is written against it. "The library is now installable" is not a
 * reason to swap a working seam for it; a concrete thing this cannot do
 * would be. See test/scaffold.test.ts, which keeps that package uninstalled
 * so the swap stays a decision rather than a resolution accident.
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
