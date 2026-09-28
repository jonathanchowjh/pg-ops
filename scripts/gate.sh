#!/usr/bin/env bash
# What the `integration` and `image` CI jobs used to run, and what
# `.githooks/pre-push` used to run inline until it turned out it could not.
#
# WHY THIS IS A SCRIPT AND NOT THE HOOK. `git push` opens the connection to
# the remote BEFORE running pre-push — it must, because the hook is handed
# each ref's remote SHA on stdin, which git can only learn by asking. So a
# hook's work happens while an idle `git-receive-pack` session is held open.
# At fifteen minutes the remote drops that session and git dies writing the
# pack to a closed pipe: exit 141, SIGPIPE, no output, not even
# `Enumerating objects`. Every push failed. Moving the work here is the only
# fix; no edit to the hook's body could have been one.
#
# Run this yourself, then push. The hook checks the receipt this writes.
#
# TWO THINGS THE WORKFLOW DID THAT THIS CANNOT:
#
# 1. Linux. This runs on the developer's machine, and the last bug this repo
#    shipped to CI was invisible on macOS: `npm run` interposes sh between
#    the harness and `next`, and on Linux a SIGTERM to npm orphans the server
#    still holding the port, so every later test silently ran against it.
#    macOS sh execs its last command, so the orphan never appeared. Every leg
#    failed in CI; every leg passed locally. Nothing below would have caught
#    it.
# 2. The 14/16/17/18 matrix in parallel. Here the versions run one after
#    another, so the default is the single version below. Run the real matrix
#    before anything you would have let CI gate:
#
#      PGOPS_HOOK_PG_VERSIONS='14 16 17 18' ./scripts/gate.sh
set -euo pipefail

versions=${PGOPS_HOOK_PG_VERSIONS:-17}

# Unquoted on purpose: this is the word split that turns '14 16 17 18' into
# four runs.
# shellcheck disable=SC2086
for v in $versions; do
  echo "gate: integration tests against Postgres $v"
  PGOPS_TEST_PG_VERSION="$v" npm run test:int
done

# The source-level half of this rule is apps/web/test/guards.test.ts (every
# page is dynamic, nothing opts back into static rendering); this is the half
# that builds an actual image on a machine with the wrong DATABASE_URL and
# runs it with the right one. Neither substitutes for the other: the guard
# cannot see a build, and a build cannot see an import.
echo "gate: image smoke test"
./scripts/image-smoke.sh

# THE RECEIPT IS A SHA, not a timestamp or a flag. Binding it to the commit
# is what stops a gate run from blessing later work: commit again and the
# receipt no longer covers what you are pushing, so the hook refuses and you
# re-gate. A "gated at 14:05" marker would have blessed everything after
# 14:05, which is the whole failure mode a gate exists to prevent.
#
# It lives in .git/ rather than the worktree: it is a fact about THIS clone's
# verification, it must never be committed, and it must survive the branch
# switches that a gitignored worktree file would survive too but that a
# tracked one would not.
sha=$(git rev-parse HEAD)
receipt="$(git rev-parse --git-dir)/pgops-gate-receipt"
printf '%s\n' "$sha" >> "$receipt"
# Bounded, because this file is append-only and nothing else prunes it. Fifty
# is far more than the handful of branch tips anyone has in flight.
tail -n 50 "$receipt" > "$receipt.tmp" && mv "$receipt.tmp" "$receipt"

echo "gate: green. $sha may be pushed."
