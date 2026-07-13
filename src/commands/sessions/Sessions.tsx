import { Box, Text } from 'ink';
import { formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import type { SessionRow } from './query.js';

function stateColor(state: string | null): string {
  if (state === 'active') return theme.success;
  if (state?.startsWith('idle in transaction')) return theme.critical;
  return theme.dim;
}

export interface SessionsProps {
  rows: SessionRow[];
  selectedIndex: number;
}

/**
 * Presentation only — selection disclosure like `LockChain.tsx`: the selected
 * row additionally shows the full query, client addr, and backend age.
 *
 * Both query renders go through `truncateQuery` (core/format.ts), which redacts:
 * these two `.slice()` calls used to put `pg_stat_activity.query` on the terminal
 * verbatim (deep-review I3). An idle session has no query text at all, so `''`
 * stays `''` rather than becoming `<no query>` on every idle row.
 */
export function Sessions({ rows, selectedIndex }: SessionsProps) {
  if (rows.length === 0) return <Text color={theme.dim}> No client sessions.</Text>;
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={r.pid} flexDirection="column">
            <Text inverse={selected}>
              {selected ? '▸ ' : '  '}
              <Text color={theme.info}>{String(r.pid).padStart(6)}</Text>{' '}
              <Text color={stateColor(r.state)}>{(r.state ?? '?').padEnd(22)}</Text>{' '}
              <Text>{formatDuration(r.inStateSecs).padStart(8)}</Text>{' '}
              <Text color={theme.dim}>{`${r.user ?? '?'}@${r.app || '?'}`}</Text>{' '}
              <Text>{r.query ? truncateQuery(r.query, 60) : ''}</Text>
            </Text>
            {selected ? (
              <Text color={theme.dim}>
                {'    '}client {r.clientAddr ?? 'local'} · session began {r.backendStart ?? '?'}
                {'\n    '}{r.query ? truncateQuery(r.query, 200) : ''}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
