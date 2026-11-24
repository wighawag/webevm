# console-log-on-the-revm-engine: decisions

Task `console-log-on-the-revm-engine` (spec `solidity-console-log`, ADR 0018). Each entry is a choice made in scope, recorded so a reviewer can ratify or reverse it.

## 1. `packages/benchmarks` moves to `revm-wasm` `^0.6.0` too

- **Chosen:** both `packages/webevm` and the private `packages/benchmarks` depend on `revm-wasm` `^0.6.0`, so the lockfile carries one revm-wasm.
- **Why:** the benchmarks compare `webevm/revm` with raw revm; on two different revm-wasm versions that delta would include a version change. The previous dependency raise (`^0.5.0`) moved both packages the same way (`packages/benchmarks/test/evm.spec.ts` says so). The benchmark suite passes unchanged on 0.6.0.
- **Alternative:** leave benchmarks on `^0.5.0` (two copies installed, benchmarks measuring an older raw revm).
- **Touches:** `packages/benchmarks/package.json`, `pnpm-lock.yaml`. Private package, no changeset.

## 2. The below-format-5 refusal is tested with a patched copy of the shipped `.wasm`

- **Chosen:** `packages/webevm/test/helpers/revm-outcome-format.ts` copies the revm `.wasm` and changes the constant `revm_wasm_outcome_format_version()` returns (its body is `i32.const 5; end`) to 4, refusing to patch if the body is anything else.
- **Why:** the acceptance criterion needs an artifact below outcome format 5, and the only other way to get one is a second, aliased `revm-wasm@0.5.0` dependency for one assertion. The patch changes exactly what the engine reads and nothing else.
- **Alternative:** an aliased old-release devDependency (needs a dependency decision); monkeypatching `WebAssembly.Instance` (depends on how revm-wasm instantiates).
- **Touches:** only `test/revm-call-recording.spec.ts`. The rationale is also in the helper's JSDoc.

## 3. `recordedCalls` is passed through from revm-wasm, never defaulted

- **Chosen:** `src/revm.ts` spreads `recordedCalls` onto the seam result exactly when revm-wasm's outcome carries it (which revm-wasm guarantees is exactly when `recordCallsTo` was set); it never substitutes `[]`.
- **Why:** a defaulted empty list would hide an artifact that was asked and answered nothing, which is the silent-mute case ADR 0018's second guard (`recordedCallsOf` in `src/node.ts`) exists to throw on.
- **Touches:** nothing outside `webevm/revm`. Recorded at the choice site (`recordedCallsOf` JSDoc in `src/revm.ts`).

## 4. The test wrapper `countingEngines` forwards `recordsCalls`

- **Chosen:** `test/helpers/conformance.ts`'s `countingEngines` (used by the concurrency, conformance and state-roundtrip batteries) forwards the engine's `recordsCalls` declaration, as it already forwards `ecrecover`.
- **Why:** it rebuilds the engine field by field, so without this a console-logging node refuses the wrapped revm engine (`got nothing`), which is how the concurrency battery's `onConsoleLog-calls-back` case on revm failed first.
- **Touches:** test code only.
