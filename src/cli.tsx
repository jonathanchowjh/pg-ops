#!/usr/bin/env node
import { runHome } from './commands/home/index.js';
import { runLocks } from './commands/locks/index.js';
import { runSessions } from './commands/sessions/index.js';
import { runTop } from './commands/top/index.js';

/**
 * Subcommand router — single entry point, multiple commands (ADR-002).
 * Each subcommand is a self-contained module under src/commands/<name>/.
 *
 * Bare `pgops` is not a help screen: it opens the triage cockpit (plan §M2),
 * the front door for someone who knows "the database feels wrong" but not which
 * subcommand to reach for. Help is still one `--help` away.
 *
 * Implemented: triage (bare), locks, top, sessions. The rest are scaffolded in
 * the plan and land per the v0 → v3 roadmap.
 */
const PLANNED = [
  'vacuum',
  'slots',
  'parts',
  'review',
  'explain',
  'events',
  'mcp',
] as const;

interface ParsedArgs {
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
      '  pgops (no subcommand)  The triage cockpit — the first five minutes on one',
      '                         screen: sessions, blocked, long-running, connections,',
      '                         and health. Enter drills into the view that can fix it.',
      '',
      'Subcommands:',
      '  locks            Incident lock-chain — root blocker + waiters, kill, snapshot',
      '  top              Live slow-query view over pg_stat_statements',
      '  sessions         Live sessions — spot & kill idle-in-transaction',
      ...PLANNED.map((s) => `  ${s.padEnd(16)} (planned)`),
      '',
      'Options:',
      '  -d, --database <url>   Connection string (defaults to $DATABASE_URL)',
      '  -h, --help             Show this help',
      '  -v, --version          Show version',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  if (!args.subcommand) {
    await runHome({ connectionString: args.connectionString, once: args.snapshot });
    return;
  }

  switch (args.subcommand) {
    case 'locks':
      await runLocks({ connectionString: args.connectionString, once: args.snapshot });
      return;
    case 'top':
      await runTop({ connectionString: args.connectionString, once: args.snapshot });
      return;
    case 'sessions':
      await runSessions({ connectionString: args.connectionString, once: args.snapshot });
      return;
    default:
      if ((PLANNED as readonly string[]).includes(args.subcommand)) {
        process.stderr.write(`pgops ${args.subcommand} is planned but not implemented yet.\n`);
      } else {
        process.stderr.write(`Unknown subcommand: ${args.subcommand}\n`);
      }
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
