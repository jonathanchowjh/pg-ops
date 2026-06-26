// Dev helper: manufacture a real lock chain and hold it open so `pgops locks`
// has something live to render. Not shipped — for local demos only.
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:secret@localhost:55432/appdb';
const mk = (app) => new pg.Client({ connectionString: url, application_name: app });

const holder = mk('batch-worker');
const web = mk('web-api');
const cron = mk('cron-cleanup');

// These sessions exist to be killed — that's the whole demo. When `pgops locks`
// terminates a backend, pg emits an 'error' event on that client; without this
// listener Node would throw "Unhandled 'error' event" and dump a stack trace
// into your terminal. Handle it: report and exit cleanly.
for (const [name, client] of [['batch-worker', holder], ['web-api', web], ['cron-cleanup', cron]]) {
  client.on('error', (err) => {
    console.log(`\n${name} connection closed (${err.code ?? err.message}) — contention released.`);
    process.exit(0);
  });
}

await holder.connect();
await web.connect();
await cron.connect();

await holder.query('CREATE TABLE IF NOT EXISTS users (id int primary key, n int)');
await holder.query('TRUNCATE users');
await holder.query('INSERT INTO users VALUES (1, 0)');

await holder.query('BEGIN');
await holder.query('UPDATE users SET n = n + 1 WHERE id = 1'); // holds the row lock

// Two sessions queue behind it (never resolve while holder's txn is open).
web.query('UPDATE users SET n = n + 1 WHERE id = 1').catch(() => {});
cron.query('DELETE FROM users WHERE id = 1').catch(() => {});

console.log('lock contention live — holder is blocking 2 sessions. Ctrl-C to release.');
// Keep the transaction open until killed.
await new Promise(() => {});
