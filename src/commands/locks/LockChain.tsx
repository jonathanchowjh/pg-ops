import { Box, Text } from 'ink';
import { theme } from '../../core/theme.js';
import { adviseBlocker } from './advise.js';
import { formatDuration, waiterAppBreakdown, type RootBlocker } from './chain.js';
import { truncateQuery } from '../../core/format.js';

function CompactRow({ root, selected }: { root: RootBlocker; selected: boolean }) {
  return (
    <Text>
      <Text color={selected ? theme.info : theme.dim}>{selected ? '❯' : ' '}</Text>
      <Text color={theme.critical}>⚠ </Text>
      <Text color={theme.fg} bold={selected}>{root.pid} </Text>
      <Text color={theme.dim}>{root.user ?? '?'}@{root.app ?? '?'}  </Text>
      <Text color={theme.warning}>{root.state ?? '?'} {formatDuration(root.heldForSecs)}  </Text>
      <Text color={theme.dim}>{root.heldMode ?? '?'} · blocking {root.totalWaiters}</Text>
    </Text>
  );
}

function ExpandedDetail({ root }: { root: RootBlocker }) {
  const advice = adviseBlocker(root);
  const breakdown = waiterAppBreakdown(root.waiters).map((b) => `${b.app}×${b.count}`).join(', ');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.dim}>    {truncateQuery(root.query, 100)}</Text>
      {breakdown ? <Text color={theme.dim}>    blocking {root.totalWaiters} → {breakdown}</Text> : null}
      <Text color={advice.tone === 'safe' ? theme.success : theme.warning}>    ▸ {advice.text}</Text>
    </Box>
  );
}

export interface LockChainProps {
  roots: RootBlocker[];
  selectedIndex: number;
}

export function LockChain({ roots, selectedIndex }: LockChainProps) {
  if (roots.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.success}>No lock contention. The DB is not blocked.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {roots.map((root, i) => (
        <Box key={root.pid} flexDirection="column">
          <CompactRow root={root} selected={i === selectedIndex} />
          {i === selectedIndex ? <ExpandedDetail root={root} /> : null}
        </Box>
      ))}
    </Box>
  );
}
