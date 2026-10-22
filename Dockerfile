# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# One stage, not the usual deps/build split, and the reason has already paid
# for itself once. This repo used to carry two React majors (18 at the root
# for the Ink TUI, 19 in apps/web); P1b deleted the TUI, react 19 stopped
# nesting under apps/web and hoisted to the root instead. A `COPY --from=deps
# /repo/apps/web/node_modules` would have been correct before that deletion
# and a build failure after it — this file needed no edit, and the smoke test
# stayed green across the change. Copying the context and installing once is
# immune to where npm chooses to put things; the cost is a slower rebuild
# when only source changed. Keep it that way: the next dependency that moves
# will not announce itself either.
FROM node:22-alpine AS build
WORKDIR /repo

COPY . .
RUN npm ci

# Exists ONLY so CI can prove the build-time value never reaches the running
# container (spec §9, "Runtime env"). A statically prerendered route would
# evaluate process.env inside THIS process and freeze the result into HTML;
# what prevents that is the `/` route staying dynamic, which several
# independent `connection()` gates each contribute to (app/page.tsx,
# app/db/[name]/layout.tsx, the kill route, and apps/web/lib/check.ts's
# runCheckFor seam — see scripts/image-smoke.sh's header for the full list
# and why no single one of them is "the" prevention). This argument is how
# the proof gets a wrong value in here to look for. Nothing in a real build
# should pass it.
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# Builds @pgops/checks first — the web app's own build script does this,
# because the package's `exports` point at dist/ and dist/ is git-ignored.
RUN npm run --workspace @pgops/web build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Verified against next/dist/build/utils.js: the standalone server.js Next
# generates reads `process.env.HOSTNAME || '0.0.0.0'` to choose its bind
# address, and Docker sets HOSTNAME to the container ID unless told otherwise
# — which binds the server to one interface instead of all of them.
#
# The same variable is read by packages/checks/src/audit.ts to name
# the host in every audit record, so with this set, `currentActor()` would
# produce `node@0.0.0.0`: a record naming neither the operator nor a
# resolvable machine. That is why the kill route always passes an explicit
# `actor` (KillMeta.actor) rather than relying on the fallback. Change one of
# these two lines and read the other first.
ENV HOSTNAME=0.0.0.0

# Standalone output is rooted at the workspace root (outputFileTracingRoot in
# apps/web/next.config.ts), so server.js lands at apps/web/server.js with a
# traced node_modules beside it. Static assets are NOT traced — Next expects
# them copied next to the server that serves them.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static

# The base image's own uid 1000. Nothing here writes to the filesystem except
# the audit log's local convenience copy, which fails loudly to stderr and does
# not stop the kill — stdout is that record's real home in a container.
USER node

EXPOSE 8080
CMD ["node", "apps/web/server.js"]
