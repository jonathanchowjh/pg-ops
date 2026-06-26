import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, render, Text } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { closePool, ConnectionError, getPool } from '../../core/connection.js';
import { buildSnapshot } from '../../core/snapshot.js';
import { theme } from '../../core/theme.js';
import { ConfirmModal } from '../../ui/ConfirmModal.js';
import { formatFreshness } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { buildChains, formatDuration, indexForPid, type RootBlocker } from './chain.js';
import { killBackend } from './kill.js';
import { LockChain } from './LockChain.js';
import { fetchLockEdges } from './query.js';
import { chainsToMarkdown } from './render.js';

const REFRESH_MS = 2_000;

interface Message {
  text: string;
  color: keyof typeof theme;
}

function LocksApp({ target }: { target?: string }) {
  const [roots, setRoots] = useState<RootBlocker[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<RootBlocker | undefined>();
  const [message, setMessage] = useState<Message | undefined>();
  const [lastPollAt, setLastPollAt] = useState(() => Date.now());
  const [, force] = useState(0);

  // Tracks the pid of the currently selected row so a re-poll can re-point the
  // index at the same backend even if the list is reordered.
  const selectedPidRef = useRef<number | undefined>(undefined);
  // Stable ref to setIndex so poll() can call it without becoming a dependency.
  const setIndexRef = useRef<((i: number) => void) | undefined>(undefined);
  // Current selected index, so poll() can hold position if the selected pid vanishes.
  const indexRef = useRef(0);

  const poll = useCallback(async () => {
    try {
      const edges = await fetchLockEdges();
      const next = buildChains(edges);
      setRoots(next);
      // Keep the cursor on the same backend across re-sorts; if it has resolved
      // and vanished, hold position (clamped) rather than snapping to the top.
      const found = indexForPid(next, selectedPidRef.current);
      setIndexRef.current?.(found >= 0 ? found : Math.min(indexRef.current, Math.max(0, next.length - 1)));
      setError(undefined);
      setLastPollAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), REFRESH_MS);
    return () => clearInterval(id);
  }, [poll]);

  const onSnapshot = useCallback(async () => {
    const md = buildSnapshot(
      { subcommand: 'locks', timestamp: new Date().toISOString(), target },
      chainsToMarkdown(roots),
    );
    const dir = join(homedir(), '.pgops', 'snapshots');
    const file = join(dir, `locks-${Date.now()}.md`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, md, 'utf8');
      setMessage({ text: `snapshot → ${file}`, color: 'success' });
    } catch (err) {
      setMessage({ text: `snapshot failed: ${(err as Error).message}`, color: 'critical' });
    }
  }, [roots, target]);

  const { index, setIndex } = useListNavigation({
    itemCount: roots.length,
    actionKeys: ['x'],
    enabled: pending === undefined,
    onSnapshot: () => void onSnapshot(),
    onAction: (key, i) => {
      // Arm the kill against the highlighted pid, not a raw index, so a poll that
      // re-sorts the list between selection and `x` can't target the wrong backend.
      if (key !== 'x') return;
      const target = roots.find((r) => r.pid === selectedPidRef.current) ?? roots[i];
      if (target) setPending(target);
    },
  });

  // Keep refs current each render so poll() sees the latest values.
  selectedPidRef.current = roots[index]?.pid;
  setIndexRef.current = setIndex;
  indexRef.current = index;

  const confirmKill = useCallback(async () => {
    const target = pending;
    setPending(undefined);
    if (!target) return;
    try {
      const ok = await killBackend(target);
      setMessage(
        ok
          ? { text: `✓ terminated pid ${target.pid} — ${target.totalWaiters} waiter(s) released`, color: 'success' }
          : { text: `pid ${target.pid} already gone`, color: 'warning' },
      );
    } catch (err) {
      setMessage({ text: `kill failed: ${(err as Error).message}`, color: 'critical' });
    }
    void poll();
  }, [pending, poll]);

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="locks"
        target={target}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={formatFreshness((Date.now() - lastPollAt) / 1000)}
        hints={['j/k move', 'x kill', 's snapshot', 'q quit']}
        message={error ? { text: error, color: 'critical' } : message}
      />
      {pending ? (
        <ConfirmModal
          title={`Kill pid ${pending.pid}?`}
          details={[
            `${pending.user ?? '?'}@${pending.app ?? '?'} holding ${pending.heldMode ?? '?'}`,
            `for ${formatDuration(pending.heldForSecs)}, blocking ${pending.totalWaiters} session(s)`,
          ]}
          onConfirm={() => void confirmKill()}
          onCancel={() => setPending(undefined)}
        />
      ) : (
        <LockChain roots={roots} selectedIndex={index} />
      )}
      {roots.length === 0 && !error ? (
        <Text color={theme.dim}> polling pg_locks…</Text>
      ) : null}
    </Box>
  );
}

export interface LocksOptions {
  connectionString?: string;
  once?: boolean;
}

export async function runLocks(opts: LocksOptions): Promise<void> {
  // Fail fast with a clear message before entering the TUI.
  try {
    getPool({ connectionString: opts.connectionString });
  } catch (err) {
    if (err instanceof ConnectionError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Redact credentials from the displayed target (host/db only).
  const target = safeTarget(opts.connectionString ?? process.env.DATABASE_URL);

  if (opts.once) {
    try {
      const edges = await fetchLockEdges();
      const body = chainsToMarkdown(buildChains(edges));
      process.stdout.write(
        buildSnapshot({ subcommand: 'locks', timestamp: new Date().toISOString(), target }, body) + '\n',
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
    return;
  }

  const { waitUntilExit } = render(<LocksApp target={target} />);
  await waitUntilExit();
  await closePool();
}

/** Show "host:port/db" without credentials for the status bar. */
function safeTarget(connectionString?: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    const u = new URL(connectionString);
    const db = u.pathname.replace(/^\//, '');
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${db ? `/${db}` : ''}`;
  } catch {
    return undefined;
  }
}
