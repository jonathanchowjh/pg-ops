import { Box, Text } from 'ink';
import { theme, type StatusMessage } from '../core/theme.js';

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
}

export function StatusBar({ subcommand, target, cadence, freshness, hints, message }: StatusBarProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.dim} paddingX={1}>
      <Box justifyContent="space-between">
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
          {target ? <Text color={theme.dim}>{target}</Text> : null}
          {cadence ? <Text color={theme.dim}>{cadence}</Text> : null}
          {freshness ? <Text color={theme.dim}>{freshness}</Text> : null}
        </Box>
        <Text color={theme.dim} wrap="truncate">
          {hints.join('  ·  ')}
        </Text>
      </Box>
      {message ? <Text color={theme[message.color]}>{message.text}</Text> : null}
    </Box>
  );
}
