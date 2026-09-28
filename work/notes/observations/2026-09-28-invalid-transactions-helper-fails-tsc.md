# `test/helpers/invalid-transactions.ts` fails the package's own `tsc`

2026-09-28, noticed by `historical-eth-call`. `npx tsc -p packages/webevm/tsconfig.json --noEmit` reports TS2322/TS2740/TS2345 at lines ~630-643 of `packages/webevm/test/helpers/invalid-transactions.ts` (typed readings such as `RefusalReading` passed where `Record<string, string>` is expected). The file was not touched by that task; the gate does not type-check tests (`build` uses `tsconfig.build.json`, and the harness bundles with esbuild), so this is invisible to `verify`.
