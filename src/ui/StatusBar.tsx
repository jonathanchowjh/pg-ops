import { Box, Text } from 'ink';
import { theme } from '../core/theme.js';

/**
 * Shared status bar across every TUI view (plan: "shared status bar").
 * Shows the subcommand, target, refresh cadence, and the key hints for this view.
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
  message?: { text: string; color: keyof typeof theme };
}

export function StatusBar({ subcommand, target, cadence, freshness, hints, message }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" borderStyle="single" borderColor={theme.dim} paddingX={1}>
      <Box gap={2}>
        <Text color={theme.info} bold>
          pgops {subcommand}
        </Text>
        {target ? <Text color={theme.dim}>{target}</Text> : null}
        {cadence ? <Text color={theme.dim}>{cadence}</Text> : null}
        {freshness ? <Text color={theme.dim}>{freshness}</Text> : null}
        {message ? <Text color={theme[message.color]}>{message.text}</Text> : null}
      </Box>
      <Text color={theme.dim}>{hints.join('  ·  ')}</Text>
    </Box>
  );
}
