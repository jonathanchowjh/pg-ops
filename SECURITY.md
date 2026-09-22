# Security

pgops connects to your databases with the credentials you give it and, when a
deployment opts in, can terminate backends and reset statistics. Take a report
about it seriously, and expect the same in return.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private
reporting on this repository ("Report a vulnerability" under the Security tab),
which reaches the maintainer directly. You should hear back within a week.

Please include what the finding lets an attacker do, the route or check
involved, and the smallest reproduction you have. A `DATABASE_URL` in a report
is never needed — describe the shape of the database instead.

## What is in scope

- Any way to run a write against a monitored database while
  `PGOPS_ALLOW_ACTIONS` is unset, or without the confirmation the tier
  requires.
- Any way for a query, a table name or a setting value read from Postgres to
  reach a page or an audit line unescaped, or for a secret to survive
  redaction.
- Any way to reach an authenticated route without the credentials the
  deployment configured.
- SQL that pgops sends which could be steered by the data it reads.

The README's [Safety](README.md#safety) section describes the gates these
protect, and the tests that hold each one.

## Out of scope

- The security of the Postgres servers themselves, or of the credentials you
  choose to give pgops. The README recommends a least-privilege role; running
  it as a superuser is a decision the deployment makes.
- Deployments that expose the console to the public internet without the
  authentication variables set. The console assumes a private network or a
  proxy in front of it.

## Supported versions

Only the latest release receives fixes. There is no LTS line.
