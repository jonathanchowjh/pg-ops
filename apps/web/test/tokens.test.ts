// Reads globals.css off disk and renders no DOM, so it does not need jsdom.
// Forcing `node` matters beyond speed: the `web` project's jsdom environment
// runs Vite's browser transform, which rewrites the literal
// `new URL('../app/globals.css', import.meta.url)` below into a
// server-relative asset URL rather than a `file://` one, and `readFileSync`
// then throws. Same pattern as guards.test.ts.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette, measured against the file that actually ships.
 *
 * WHY THIS EXISTS. Colour on this console is not decoration: it is the
 * verdict. A `CRITICAL` badge an operator cannot read at 3am on a laptop in a
 * bright room is the one failure this project cannot argue its way out of,
 * and it is invisible to every other test here — the component tests assert
 * on text and roles, which is correct of them and blind to this.
 *
 * It found a real one. The `CRITICAL` badge in light mode measured **3.99:1**
 * — `oklch(0.577 0.245 27.325)` on its own 10% tint — against the 4.5:1 floor
 * WCAG sets for text at these sizes. On the loudest signal the console has.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, because these are judgement and not
 * arithmetic: whether a tint is VISIBLE (the surfaces are intentionally
 * barely there — the badge and the accent bar carry the signal, the tint only
 * groups the panel's parts), and whether a hue is right. Those are what the
 * screenshots are for.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../app/globals.css', import.meta.url)),
  'utf8',
);

type Rgb = [number, number, number];

/**
 * oklch -> LINEAR sRGB, unclamped. Björn Ottosson's matrices, unchanged.
 *
 * Unclamped on purpose: a channel outside 0..1 here is the only way to tell
 * that a colour is outside the sRGB gamut, which the last test in this file
 * forbids for every token it measures. See there for why that matters.
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
 * The same colour gamma-encoded and clamped — what a screen actually shows.
 *
 * The clamp only bites on a colour outside the gamut, and the test below
 * makes sure none of the measured tokens is. That test exists because
 * clamping is not what a browser does with one: CSS Color 4 says to gamut-MAP
 * (reduce chroma until it fits), Tailwind emits its own hex fallback computed
 * a third way, and the three disagree by about 0.1 of a ratio. A token inside
 * the gamut removes the disagreement instead of picking a winner.
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
 *
 * Composited in gamma-encoded sRGB, which is what a browser does for ordinary
 * alpha — not in linear light. Compositing in linear space would give a
 * lighter tint and a ratio this console never actually paints.
 */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]!) as Rgb;
}

/**
 * The tokens of one theme, as the browser resolves them: the dark block
 * overrides the light one and inherits everything it does not name.
 *
 * `:root {...}` twice in the file — the light block, then the one inside
 * `@media (prefers-color-scheme: dark)`. Parsed rather than imported because
 * the point is to measure THE FILE THAT SHIPS; a table of constants in a test
 * would only ever agree with itself.
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

  // Each severity's INK — the colour its badge text and heading are painted
  // in. One indirection, so the day the badge stops using `--destructive`
  // this test follows it rather than going quietly out of date.
  const critical = get('--critical-ink');
  const warning = get('--warning-ink');
  const success = get('--success-ink');

  return [
    // The badge sits on the canvas on a healthy row and on a card inside an
    // escalated panel. BOTH are asserted: the canvas is the darker of the two
    // in light mode, so the tint over it is darker and the ratio lower — the
    // binding case, and the one an earlier measurement missed.
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
 * The tints are a GROUND, not a highlight — barely there on purpose, because
 * the badge and the accent bar carry the signal and a red wash across a panel
 * would shout over them. This is the other end of that: faint is intended,
 * invisible is not, and a surface that drifted to within a rounding error of
 * the canvas would silently stop grouping anything.
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
 * Every measured token is inside sRGB, so its ratio is not a matter of
 * opinion.
 *
 * Found while checking this test against the built stylesheet:
 * `oklch(0.52 0.22 27.325)` is very slightly outside the gamut — green
 * −0.006. Nobody can see the difference, but three parties resolve it three
 * ways. The browser gamut-maps per CSS Color 4, Tailwind emits a hex fallback
 * from its own conversion, and the arithmetic above clamps; the ratios came
 * out 4.91, 4.91 and 4.80. All three passed, which is exactly why this is
 * worth pinning rather than shrugging at — the next token might not have
 * 0.4 of headroom, and then the test and the screen would disagree about
 * whether the console is readable.
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
