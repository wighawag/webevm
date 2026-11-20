# The manual forge check of `toAllocs`, run once

The script is `packages/devnode/scripts/forge-load-allocs.mjs` (documented in `packages/devnode/README.md`, "Handing a chain to forge"). It is not run in CI, because forge is not installed there.

## Run

Run on 2026-11-20 (machine date) from `packages/devnode`, with `forge Version: 1.7.1-dev` (`Commit SHA: refs/tags/v1.7.1`), the same forge version rocketh used by hand; forge picked Solc 0.8.28:

```
$ pnpm build && node scripts/forge-load-allocs.mjs
[forge-load-allocs] project: /tmp/webevm-devnode-forge-gzX1KO
Compiling 1 files with Solc 0.8.28
Solc 0.8.28 finished in 9.22ms
Compiler run successful!

Ran 2 tests for test/Allocs.t.sol:AllocsTest
[PASS] test_theDeploymentIsLoaded() (gas: 7968)
[PASS] test_theDevAccountsAreLoaded() (gas: 6134)
Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 403.16µs (216.33µs CPU time)

Ran 1 test suite in 3.10ms (403.16µs CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)
```

The forge test loads the exported `allocs.json` with `vm.loadAllocs` and checks the deployed contract's code, its nonce (1), slot 0 (`42`, written by its constructor), a call to it returning `42`, the deployer's nonce (1) and its balance after the deployment fee, and dev account 1's genesis 10,000 ETH.

## Negative control

To check the forge test can fail, the same run was repeated with `--keep`, slot 0's value in the kept `allocs.json` was replaced by hand with `0x2b`, and `forge test` was re-run in that project: `[FAIL: slot 0] test_theDeploymentIsLoaded()`, the other test passing. So the test reads the loaded state rather than passing whatever the file holds. That run also showed that forge 1.7.1 accepts an UNPADDED storage value (`0x2b`), so the 32-byte padding `toAllocs` does is what the task asks for and what a strict B256 reader needs, not something forge 1.7.1 enforces.
