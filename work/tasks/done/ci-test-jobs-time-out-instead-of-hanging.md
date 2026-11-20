---
title: CI test jobs time out instead of hanging for six hours
slug: ci-test-jobs-time-out-instead-of-hanging
blockedBy: []
covers: []
---

## What to build

Give the `test` jobs in `.github/workflows/ci.yml` (the chromium and webkit matrix) a `timeout-minutes` of 20, so that a stalled step fails fast and a re-run clears it, instead of holding the job for GitHub's default of six hours. The webkit job's `install browser` step hung for over 25 minutes on 2026-11-20 and only a manual cancel and re-run cleared it (`work/notes/observations/2026-11-20-ci-browser-install-step-can-hang-with-no-timeout.md`). A green test job takes about 3 to 4 minutes today, so 20 leaves ample room. The maintainer approved this CI change on 2026-11-20.

Leave every other job, step and trigger as it is. Consider the `format + build` job too: if it has no timeout either, give it one sized the same way (it takes well under a minute), and say so in the done record.

## Acceptance criteria

- [ ] The `test` matrix job in `.github/workflows/ci.yml` has `timeout-minutes: 20`.
- [ ] Nothing else in the workflow changes, except an optional timeout on `format + build`, recorded in the done record.
- [ ] The observation note `work/notes/observations/2026-11-20-ci-browser-install-step-can-hang-with-no-timeout.md` is deleted in the same change, since this task discharges it.
- [ ] CI on the PR is green. No changeset: no published package changes.

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm, a pnpm monorepo whose CI is `.github/workflows/ci.yml`. Add `timeout-minutes: 20` to the `test` matrix job (chromium and webkit), so a stalled step such as `install browser` fails fast instead of holding the job for GitHub's six-hour default. Read `work/notes/observations/2026-11-20-ci-browser-install-step-can-hang-with-no-timeout.md` for why, and delete it in the same change.

FIRST, check this task against current reality: if the jobs already have a timeout, route the task to needs-attention instead of building.

Change nothing else in the workflow: no new jobs, steps, triggers, actions or versions. A timeout on the `format + build` job is optional; if you add one, record it in a `## Decisions` block in the done record. Never write the em dash character. Bound shell commands with `timeout` and cap their output; never grep `node_modules`, `dist` or `.git` recursively. The verify gate is `pnpm format:check && pnpm build && pnpm test`.
