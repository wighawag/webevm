# The test helpers do not type-check under the package tsconfig

2026-11-20. `npx tsc --noEmit -p packages/webevm/tsconfig.json` reports TS2322/TS2345/TS2740 errors in `packages/webevm/test/helpers/invalid-transactions.ts` (around lines 630-643: readings typed `Record<string, string>` vs `RefusalReading` / `AffordableReading` / `NonceCheckReading`). The verify gate does not type-check tests (`pnpm build` uses `tsconfig.build.json`), so this is invisible to it. Seen while doing `worker-host-takes-a-node-factory`; not touched.
