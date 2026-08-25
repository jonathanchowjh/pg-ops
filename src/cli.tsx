#!/usr/bin/env node
import { runShell, type ShellTab } from './commands/shell/run.js';

/**
 * Subcommand router — single entry point, one app (ADR-002, spec §5.3).
 *
 * Every subcommand opens the SAME app on a different tab: `pgops locks` is
 * `pgops` with `3` already pressed. There is no longer a runner per command —
 * `runShell` is the only door, because `Shell` mounts all four views and a view
 * that reached back for `Shell` would close an import cycle (RULING R-P6).
 *
 * Bare `pgops` is not a help screen: it opens the triage cockpit (plan §M2),
 * the front door for someone who knows "the database feels wrong" but not which
 * subcommand to reach for. Help is still one `--help` away.
 *
 * `--snapshot` never enters the TUI. It keeps the one-shot path and its
 * exit-code contract (`src/core/run-view.tsx`), per tab.
 *
 * Implemented: triage (bare), locks, top, sessions. The rest are planned, and
 * planned in two different shapes — see the two lists below.
 */

/**
 * Subcommand → the tab it opens on. The four views that exist today.
 *
 * `triage` is here as well as being the bare-`pgops` default: it is the one
 * name printed on the strip, in `--help`, and in the README, so it is the tab
 * an operator is most likely to type — and `pgops triage --snapshot` has to
 * reach the same one-shot every other tab has.
 */
const BUILT: Record<string, ShellTab> = {
  triage: 'triage',
  locks: 'locks',
  top: 'top',
  sessions: 'sessions',
};

/**
 * Planned areas that HOLD a digit on the tab strip (spec §5.3). Each can
 * escalate to "act now" under §5.2, so each has a key — and, until it is built,
 * a placeholder behind that key naming the phase that delivers it. The
 * subcommand still errors: a placeholder is not a view, and needing a database
 * connection to be told "not built yet" would be worse than the message.
 */
const PLANNED_TABS = ['space', 'vacuum', 'replication', 'seq', 'system'] as const;

/**
 * Planned areas with NO digit, deliberately and permanently (spec §5.3).
 * `indexes`, `tables` and `config` escalate to "now" *never*, so a
 * single-keystroke incident jump would be real estate spent on something you
 * would never press it for; `explain` is contextual (Enter on a `top` row);
 * `doctor` is a report *over* the areas rather than one beside them, so it
 * takes `D`, not a number. These are subcommands and drill-in targets, not tabs.
 */
const PLANNED_NO_TAB = [
  'doctor',
  'indexes',
  'tables',
  'config',
  'explain',
  'parts',
  'review',
  'events',
  'mcp',
] as const;

const PLANNED: readonly string[] = [...PLANNED_TABS, ...PLANNED_NO_TAB];

export interface ParsedArgs {
  subcommand?: string;
  connectionString?: string;
  help: boolean;
  version: boolean;
  snapshot: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, version: false, snapshot: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '-v' || arg === '--version') out.version = true;
    else if (arg === '-d' || arg === '--database') out.connectionString = argv[++i];
    else if (arg === '--snapshot') out.snapshot = true;
    else if (arg && !arg.startsWith('-') && !out.subcommand) out.subcommand = arg;
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      'pgops — Postgres on-call toolkit. Run it during the incident.',
      '',
      'Usage: pgops [subcommand] [options]',
      '',
      'pgops is one app with nine tabs. A subcommand opens it on that tab; from',
      'anywhere inside, every other view is one keystroke away:',
      '',
      '  1-9              Jump to a tab: 1 triage · 2 sessions · 3 locks · 4 top',
      '                   5 space · 6 vacuum · 7 replication · 8 seq · 9 system',
      '  Tab / Shift-Tab  Cycle tabs forward / back',
      '  D doctor         The hygiene report — findings that can wait',
      '  Esc              Back to triage (dismisses an open confirm or filter first)',
      '',
      '  pgops (no subcommand)  The triage cockpit — the first five minutes on one',
      '                         screen: sessions, blocked, long-running, connections,',
      '                         and health. Enter drills into the view that can fix it.',
      '',
      'Subcommands:',
      '  triage           The cockpit — same as bare `pgops`',
      '  locks            Incident lock-chain — root blocker + waiters, kill, snapshot',
      '  top              Live slow-query view over pg_stat_statements',
      '  sessions         Live sessions — spot & kill idle-in-transaction',
      '',
      'Planned — hold tabs 5-9, a placeholder behind the key until built:',
      `  ${PLANNED_TABS.join('  ')}`,
      '',
      'Planned — no tab, by design: reached by name or from doctor:',
      `  ${PLANNED_NO_TAB.join('  ')}`,
      '',
      'Options:',
      '  -d, --database <url>   Connection string (defaults to $DATABASE_URL)',
      '      --snapshot         Print the view as markdown and exit (no TUI)',
      '  -h, --help             Show this help',
      '  -v, --version          Show version',
      '',
    ].join('\n'),
  );
}

/**
 * Argv → what runs. Exported so the routing can be asserted directly: shelling
 * out to the real binary proves nothing about it, because without a database
 * every path exits before a view is ever mounted (`src/cli.test.ts`).
 */
export async function route(args: ParsedArgs): Promise<void> {
  if (args.version) {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  // Bare `pgops`: no tab named, so the shell opens on the cockpit.
  if (!args.subcommand) {
    await runShell({ connectionString: args.connectionString, once: args.snapshot });
    return;
  }

  const tab = BUILT[args.subcommand];
  if (tab !== undefined) {
    await runShell({ tab, connectionString: args.connectionString, once: args.snapshot });
    return;
  }

  if (PLANNED.includes(args.subcommand)) {
    process.stderr.write(`pgops ${args.subcommand} is planned but not implemented yet.\n`);
  } else {
    process.stderr.write(`Unknown subcommand: ${args.subcommand}\n`);
  }
  process.exitCode = 1;
}

route(parseArgs(process.argv.slice(2))).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
