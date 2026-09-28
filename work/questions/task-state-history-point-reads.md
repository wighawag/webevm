<!-- dorfl-sidecar: item=task:state-history-point-reads type=task slug=state-history-point-reads allAnswered=false -->

## Q1

**'task:state-history-point-reads' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/benchmarks test:     Received:    [31m439.2[39m
> packages/benchmarks test:       574 | 		`the default entry point grew to ${sizes['webevm'].rawKB} KB raw (baseline ${DEFAULT_ENTRY_BASELINE.rawKB} KB) — ` +
> packages/benchmarks test:       575 | 			'either something was imported into the core graph, or the growth is intended and this baseline must be re-pinned in the same change',
> packages/benchmarks test:     > 576 | 	).toBeLessThanOrEqual(DEFAULT_ENTRY_BASELINE.rawKB);
> packages/benchmarks test:           | 	  ^
> packages/benchmarks test:       577 | 	expect(sizes['webevm'].gzipKB).toBeLessThanOrEqual(
> packages/benchmarks test:       578 | 		DEFAULT_ENTRY_BASELINE.gzipKB * GZIP_SLACK,
> packages/benchmarks test:       579 | 	);
> packages/benchmarks test:         at /tmp/dorfl-fresh-gate-uudiMS/tip/packages/benchmarks/test/evm.spec.ts:576:4
> packages/benchmarks test:     Error Context: test-results/evm-bundle-size-per-backend-raw-gzip--webkit/error-context.md
> packages/benchmarks test:     Error Context: test-results/evm-bundle-size-per-backend-raw-gzip--webkit/error-context.md
> packages/benchmarks test:   2 failed
> packages/benchmarks test:     [chromium] › test/evm.spec.ts:497:1 › bundle size per backend (raw + gzip) ─────────────────────
> packages/benchmarks test:     [webkit] › test/evm.spec.ts:497:1 › bundle size per backend (raw + gzip) ───────────────────────
> packages/benchmarks test:   18 passed (1.0m)
> packages/benchmarks test: Failed
> /tmp/dorfl-fresh-gate-uudiMS/tip/packages/benchmarks:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  webevm-benchmarks@0.0.0 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
