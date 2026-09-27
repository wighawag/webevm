# `tsc -p tsconfig.json` fails in `test/helpers/invalid-transactions.ts`

2026-09-27. Typechecking the package WITH its tests (`pnpm exec tsc -p tsconfig.json` in `packages/webevm`) reports TS2322/TS2345/TS2740 errors around lines 630-643 of `test/helpers/invalid-transactions.ts` (typed readings such as `RefusalReading` passed where `Record<string, string>` is expected). Not introduced by the serve-on-port task and invisible to `verify`, which only builds `src` (`tsconfig.build.json`) and runs the specs through esbuild, so the test helpers are never typechecked by the gate.
