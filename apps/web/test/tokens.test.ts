// `node`, not jsdom, for the reason given in guards.test.ts.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: measures the contrast of the palette in globals.css, the file that
 * ships. It catches a verdict colour that falls below WCAG's 4.5:1 for text,
 * which component tests asserting on text and roles cannot see. It does not
 * judge whether a hue is right.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../app/globals.css', import.meta.url)),
  'utf8',
);

type Rgb = [number, number, number];

/**
 * oklch -> linear sRGB, Björn Ottosson's matrices. Unclamped on purpose: a
 * channel outside 0..1 is how the last test in this file detects a colour
 * outside the sRGB gamut.
 */
function linearSrgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/**
 * The same colour gamma-encoded and clamped. The clamp only bites on a
 * colour outside the gamut, which is not what a browser does with one (CSS
 * Color 4 gamut-maps); the last test keeps every measured token inside it.
 */
function srgb(L: number, C: number, H: number): Rgb {
  return linearSrgb(L, C, H).map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  }) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = [r, g, b].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG 2.2's contrast ratio, order-independent. */
function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Tailwind's `bg-x/10`: the token painted at 10% over whatever is behind it.
 * Composited in gamma-encoded sRGB, as a browser does for ordinary alpha;
 * linear space would give a lighter tint than is painted.
 */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]!) as Rgb;
}

/**
 * The tokens of one theme, as the browser resolves them: the dark block
 * overrides the light one and inherits everything it does not name.
 * `:root {...}` appears twice in the file — the light block, then the one
 * inside `@media (prefers-color-scheme: dark)`.
 */
function theme(which: 'light' | 'dark'): Map<string, Rgb> {
  const blocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  const source = which === 'light' ? [blocks[0]!] : [blocks[0]!, blocks[1]!];
  const out = new Map<string, Rgb>();
  for (const block of source) {
    for (const m of block.matchAll(/(--[\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
      out.set(m[1]!, srgb(Number(m[2]), Number(m[3]), Number(m[4])));
    }
  }
  return out;
}

/** Every pair the console paints text on, and the surface it paints it over. */
function pairs(which: 'light' | 'dark') {
  const t = theme(which);
  const get = (name: string): Rgb => {
    const v = t.get(name);
    if (v === undefined) throw new Error(`globals.css has no ${name} in the ${which} theme`);
    return v;
  };
  // badge.tsx paints its tint at 10% in light and 20% in dark.
  const tint = which === 'light' ? 0.1 : 0.2;
  const canvas = get('--background');
  const card = get('--card');

  // Each severity's ink: the colour its badge text and heading are painted in.
  const critical = get('--critical-ink');
  const warning = get('--warning-ink');
  const success = get('--success-ink');

  return [
    // The badge sits on the canvas on a healthy row and on a card inside an
    // escalated panel. Both are asserted: in light mode the canvas is the
    // darker, so the tint over it is darker and the ratio lower.
    ['critical badge on the canvas', critical, over(critical, canvas, tint)],
    ['critical badge on a card', critical, over(critical, card, tint)],
    ['warning badge on the canvas', warning, over(warning, canvas, tint)],
    ['warning badge on a card', warning, over(warning, card, tint)],
    ['success badge on the canvas', success, over(success, canvas, tint)],
    ['success badge on a card', success, over(success, card, tint)],
    ['critical heading on the escalated surface', critical, get('--critical-surface')],
    ['warning heading on the escalated surface', warning, get('--warning-surface')],
    ['body text on the canvas', get('--body'), canvas],
    ['body text on the escalated surface', get('--body'), get('--critical-surface')],
    ['caption on the canvas', get('--muted-foreground'), canvas],
    ['caption on a card', get('--muted-foreground'), card],
    ['headings on the canvas', get('--foreground'), canvas],
    ['caption on a filled row', get('--muted-foreground'), get('--muted')],
    ['body text on a card', get('--body'), card],
    ['body text on the sidebar', get('--body'), get('--sidebar')],
    ['headings on the answer line', get('--foreground'), get('--warning-surface')],
    ['the warning ink on the canvas', warning, canvas],
    ['the focus ink on the canvas', get('--focus'), canvas],
  ] as const;
}

/** WCAG 2.2 AA for text below 18.66px bold / 24px regular. Everything here is. */
const AA = 4.5;

describe.each(['light', 'dark'] as const)('the %s palette', (which) => {
  it.each(pairs(which).map((p) => [p[0], p[1], p[2]] as const))(
    'reads %s at 4.5:1 or better',
    (_what, fg, bg) => {
      expect(Number(contrast(fg, bg).toFixed(2))).toBeGreaterThanOrEqual(AA);
    },
  );
});

/**
 * The surface tints are faint on purpose (the badge and the accent bar carry
 * the signal), but must not drift to indistinguishable from the canvas.
 */
describe.each(['light', 'dark'] as const)('the %s surfaces', (which) => {
  it('are distinguishable from the canvas without shouting', () => {
    const t = theme(which);
    const canvas = t.get('--background')!;
    for (const name of ['--critical-surface', '--warning-surface']) {
      const ratio = contrast(t.get(name)!, canvas);
      expect(ratio).toBeGreaterThan(1.02);
      expect(ratio).toBeLessThan(1.4);
    }
  });
});

/**
 * A token outside sRGB is resolved three ways: the browser gamut-maps per
 * CSS Color 4, Tailwind emits a hex fallback from its own conversion, and
 * the arithmetic above clamps. The ratios differ by about 0.1, so the test
 * and the screen could disagree. Keeping tokens inside the gamut removes it.
 */
describe.each(['light', 'dark'] as const)('the %s tokens', (which) => {
  it('are inside the sRGB gamut, so the measurement is unambiguous', () => {
    const blocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    const block = which === 'light' ? blocks[0]! : blocks[1]!;
    const measured = /-(ink|surface)$/;
    for (const m of block.matchAll(/(--[\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
      if (!measured.test(m[1]!)) continue;
      const channels = linearSrgb(Number(m[2]), Number(m[3]), Number(m[4]));
      for (const c of channels) {
        expect(
          c, `${m[1]} leaves sRGB — reduce its chroma until it fits`,
        ).toBeGreaterThanOrEqual(-1e-6);
        expect(c, `${m[1]} leaves sRGB — reduce its chroma`).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
});

/** The spec's Colour table, in stacking order. A change here is a change to the spec. */
const CLASS_HUES = {
  light: ['#2457c7', '#0e9f9f', '#9a5cd0', '#8a909c', '#e2640f'],
  dark: ['#4288e4', '#1ea68e', '#9566dc', '#8a909c', '#de6b26'],
} as const;
const CLASS_ORDER = ['cpu', 'io', 'idle', 'other', 'lock'];

function hex(h: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

describe.each(['light', 'dark'] as const)('the %s class hues', (which) => {
  const blocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  const block = which === 'light' ? blocks[0]! : blocks[1]!;
  const found = [...block.matchAll(/--class-(\w+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!] as const);

  it('are the spec\'s five, declared in stacking order', () => {
    expect(found.map((f) => f[0])).toEqual(CLASS_ORDER);
    expect(found.map((f) => f[1])).toEqual([...CLASS_HUES[which]]);
  });

  /** 3:1, WCAG's floor for a graphical mark, against the panel a strip is drawn on. */
  it('each read 3:1 against the panel a strip is drawn on', () => {
    const card = theme(which).get('--card')!;
    for (const [name, value] of found) {
      expect(Number(contrast(hex(value), card).toFixed(2)), name).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * Every `<i>` in the app is a dot, a bar or a rule, and a chart's labels sit
 * inside them: under the browser's own italic they leaned. One rule in the
 * base layer, not a `not-italic` on each label that someone will forget.
 */
describe('the base layer', () => {
  it('sets <i> upright', () => {
    const base = /@layer base \{([\s\S]*)\}\s*$/.exec(CSS)?.[1] ?? '';
    expect(base).toMatch(/(^|\n)\s*i \{\s*font-style: normal;/);
  });
});
