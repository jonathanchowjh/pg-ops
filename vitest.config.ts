import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// The integration suite's saved databases: none. PGOPS_CONFIG_FILE must name
// a file that exists, so it is made here. See the env block below.
const INTEGRATION = join(tmpdir(), 'pgops-integration-tests');
mkdirSync(INTEGRATION, { recursive: true });
writeFileSync(join(INTEGRATION, 'databases.json'), '[]\n');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/**/*.int.test.ts', 'apps/web/test/**/*.int.test.ts'],
          // I4: `killBackend` ALWAYS writes an audit record, and this suite
          // performs real kills. Without this, every `npm run test:int`
          // appended genuine-looking `action: "kill"` records — real pid,
          // real backend_start, real `user@host` — to the developer's own
          // ~/.pgops/audit.log, the file audit.ts calls "the mitigation for
          // the malicious operator threat". Nothing but a free-text
          // `reason: "test"` distinguished them from real ones, and this
          // already happened on a developer machine before it was caught.
          // audit.test.ts had it right all along with mkdtemp; only the
          // integration path forgot. kill.int.test.ts asserts the resolved
          // path is outside the real home directory, so deleting this line
          // is a red test rather than a silent leak back into a real log.
          // The same holds for the saved databases: unset, every console the
          // suite starts would read the developer's ~/.pgops/databases.json.
          env: {
            PGOPS_AUDIT_LOG: join(INTEGRATION, 'audit.log'),
            PGOPS_CONFIG_FILE: join(INTEGRATION, 'databases.json'),
          },
          // Starts the one Postgres container for the whole run, once, in
          // Vitest's main process — see global-setup.ts for why module-scope
          // state in a test file can't give that guarantee under isolate:true.
          globalSetup: ['./packages/checks/test/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Every integration file shares ONE Postgres container (see
          // global-setup.ts) but gets its own database — and pg_stat_activity,
          // pg_locks, and the lock manager are cluster-wide, not scoped to a
          // database. Checks that read them (locks, blocked, longRunning)
          // do NOT filter by datname; `sessions` does, since the tree places
          // a session on tables only its own database can name. Left
          // parallel, sibling files' own short-lived fixtures (a blocked
          // session, a sleeping backend) become visible to each other's
          // assertions and race. Do not remove this to speed CI up: it does not
          // fix flaky checks, it removes the file-level source of the flake
          // those checks would otherwise have to poll around individually.
          fileParallelism: false,
        },
      },
      // The web app owns its own vitest config. It carries the jsdom
      // environment and the React plugin that only this app needs, and it is
      // rooted in apps/web because Vite resolves bare specifiers from the
      // CONFIG's directory — which is what kept the app's react, react-dom
      // and react/jsx-runtime resolving together while the repo still had
      // two react majors (18 at the root for Ink, 19 here). P1b deleted the
      // TUI and with it the second major; see that file's header for why it
      // nonetheless stays a separate file.
      './apps/web/vitest.config.ts',
    ],
  },
});
