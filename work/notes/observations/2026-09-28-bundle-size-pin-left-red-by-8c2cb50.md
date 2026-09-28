---
title: The bundle-size pin was left red on main by 8c2cb50
date: 2026-09-28
status: open
---

Found while building `state-change-set-capture`: `packages/benchmarks/test/evm.spec.ts` › "bundle size per backend" FAILS on `origin/main` as it stands, because the default entry point measures 432.0 KB raw / 130.3 KB gzip against the 426.2 / 128.6 pin. The only `packages/webevm/src` change since the pin was set (`ffb6451`) is `8c2cb50` (honour or refuse every request parameter the node used to ignore), so that commit grew the core bundle by 5.8 KB without re-pinning, and `pnpm test` (hence `verify`) has been red on main since. Measured with `pnpm build` then the benchmarks spec on chromium, on this branch with `origin/main`'s versions of the two touched source files swapped in.

`state-change-set-capture` had to re-pin for its own growth (432.0 -> 436.3) and could not do so without also absorbing this, so it re-pinned to 436.3 / 131.4 and wrote BOTH steps into the pin's history comment, the `8c2cb50` one marked as not re-pinned when it landed. Worth checking whether the gate actually ran on `8c2cb50`, since a verify step that did not catch this would miss the next one too.

Separately, and not a code problem: in this runner's environment WebKit only launches with `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` set (telemaque's documented setup turns Playwright's host preflight off; the variable was not set in the dorfl session), so `pnpm exec playwright test --project=webkit` fails every test at launch without it.
