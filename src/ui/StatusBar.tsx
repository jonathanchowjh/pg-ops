import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { fitToWidth } from '../core/format.js';
import { theme, type StatusMessage } from '../core/theme.js';

/** Border (1 each side) plus `paddingX={1}` (1 each side). */
const BAR_CHROME = 4;
/** The `gap={2}` between the facts. */
const GAP = 2;
/**
 * Kept clear between the last fact and the first hint.
 *
 * `justifyContent="space-between"` puts no gap of its own between the two
 * children — it distributes whatever space is left over, and when the target
 * has been truncated to fill the row exactly, that is none. The bar then reads
 * `updated just nowj/k panels`, with the last fact and the first hint welded
 * together. Two columns is the same gap the facts already use among
 * themselves.
 */
const HINT_GAP = 2;
/**
 * Floor for the target. Below this the label stops identifying anything, and
 * an operator on two terminals needs to know which database this one is.
 */
const MIN_TARGET = 10;

/**
 * How wide the target may be before it starts pushing the bar off the screen.
 *
 * The facts row is `flexShrink={0}` on purpose — see the comment on it below —
 * so nothing in it shrinks, and Ink resolves an over-wide row by *wrapping* it.
 * Every other fact is bounded: `pgops <subcommand>` is at most 17 columns,
 * cadence is `every Ns`, freshness is `updated ... ago`. The target is the one
 * unbounded fact, because it is a hostname: an ordinary RDS endpoint like
 * `prod-cluster-01.abcdefgh.eu-west-1.rds.amazonaws.com:5432/appdb` is 62
 * columns, and at the 80-column floor that alone overruns the bar's own right
 * border and wraps it onto a second row. Every view budgets the bar at 3 lines
 * (`STATUS_BAR_LINES`), so a 4-line bar means the table below it overflows the
 * terminal — the defect the geometry phase existed to remove.
 *
 * So the target is truncated to whatever the bounded facts leave. Hints get
 * nothing here; they are already `wrap="truncate"` and they are the thing the
 * bar is documented to give up first.
 */
function targetRoom(width: number, subcommand: string, cadence?: string, freshness?: string): number {
  const bounded =
    stringWidth(`pgops ${subcommand}`) +
    (cadence ? GAP + stringWidth(cadence) : 0) +
    (freshness ? GAP + stringWidth(freshness) : 0);
  return Math.max(MIN_TARGET, width - BAR_CHROME - bounded - GAP - HINT_GAP);
}

/**
 * Shared status bar across every TUI view (plan: "shared status bar").
 *
 * The standard layout is `subcommand · target · cadence · freshness · hints`,
 * and every view passes all of it (deep-review I2): `top` and `sessions` used to
 * assert a cadence with no freshness, so a view whose polls had been failing for
 * 90 seconds still read as live — on `sessions`, the view you kill from.
 *
 * Cadence is the *promise*; freshness is the *fact*. If they can't both fit an
 * 80-column terminal, freshness is the one that must survive — it is the only
 * label that can contradict the screen.
 */
export interface StatusBarProps {
  subcommand: string;
  target?: string;
  /** e.g. "every 2s" — omit for one-shot views. */
  cadence?: string;
  /** e.g. "updated 3s ago" — liveness indicator. */
  freshness?: string;
  /** Key hints rendered on the right, e.g. ["k kill", "s snapshot", "q quit"]. */
  hints: string[];
  /** Optional transient message (errors, "snapshot written", ...). */
  message?: StatusMessage;
  /**
   * Total display columns available. Supplied by the container, which reads the
   * terminal once; omit it and the target is left untruncated, which is what
   * every direct-render test wants. Same contract as `Sessions`' detail panel:
   * one default, owned by whoever reads the terminal, never a second one here.
   */
  width?: number;
}

export function StatusBar({ subcommand, target, cadence, freshness, hints, message, width }: StatusBarProps) {
  const shownTarget =
    target !== undefined && width !== undefined
      ? fitToWidth(target, targetRoom(width, subcommand, cadence, freshness))
      : target;
  return (
    // `width` on the root, the way `Table` and `TabStrip` set theirs. Without
    // it Ink lays the bar out against the physical stdout, so the truncation
    // above would be invisible to any test — and, worse, a test asserting the
    // bar fits would be measuring the terminal rather than the bar.
    <Box flexDirection="column" borderStyle="single" borderColor={theme.dim} paddingX={1} width={width}>
      <Box justifyContent="space-between" gap={HINT_GAP}>
        {/*
          The facts never shrink (flexShrink 0). With freshness now on all four
          views (I2), the row can outgrow the terminal — and Ink's default is to
          mid-word-wrap the flex children, which split "updated just now" across
          two lines. When something has to give, it's the hints: they're static
          and learnable, while target/cadence/freshness are the state of the
          world, and freshness is the only label that can contradict the screen.
        */}
        <Box gap={2} flexShrink={0}>
          <Text color={theme.info} bold>
            pgops {subcommand}
          </Text>
          {shownTarget ? <Text color={theme.dim}>{shownTarget}</Text> : null}
          {cadence ? <Text color={theme.dim}>{cadence}</Text> : null}
          {freshness ? <Text color={theme.dim}>{freshness}</Text> : null}
        </Box>
        <Text color={theme.dim} wrap="truncate">
          {hints.join('  ·  ')}
        </Text>
      </Box>
      {/*
        Truncate, never wrap. `sessions/index.tsx` and `top/index.tsx` both
        derive their table's line budget from a flat "+1 for the message
        line" — that arithmetic is only true if the message can never spill
        onto a second line. A long message (e.g. `snapshot-file.ts`'s
        `snapshot → <path>` on a wide home directory, or `top/index.tsx`'s
        `explain()` hints) would otherwise wrap inside this bordered,
        paddingX-1 box and cost 5 lines instead of 4.
      */}
      {message ? (
        <Text color={theme[message.color]} wrap="truncate">
          {message.text}
        </Text>
      ) : null}
    </Box>
  );
}
