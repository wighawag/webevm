<!-- dorfl-sidecar: item=task:state-history-docs-and-worker type=task slug=state-history-docs-and-worker allAnswered=false -->

## Q1

**'task:state-history-docs-and-worker' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/webevm test:        at state-history-expected.ts:28
> packages/webevm test:       26 | 	// ---- THE DIFFERENTIAL: every read at every K equals K's snapshot ----
> packages/webevm test:       27 | 	const d = c.differential;
> packages/webevm test:     > 28 | 	expect(d.deterministic, `${label}: the two runs agree`).toBe(true);
> packages/webevm test:          | 	                                                        ^
> packages/webevm test:       29 | 	expect(Object.keys(d.receipts).length, label).toBe(
> packages/webevm test:       30 | 		CHANGE_SET_BLOCKS.length - 1,
> packages/webevm test:       31 | 	);
> packages/webevm test:         at assertStateHistory (/tmp/dorfl-fresh-gate-1AvsdE/tip/packages/webevm/test/state-history-expected.ts:28:58)
> packages/webevm test:         at /tmp/dorfl-fresh-gate-1AvsdE/tip/packages/webevm/test/revm-state-history.spec.ts:34:2
> packages/webevm test:     Error Context: test-results/revm-state-history-point-r-e765e-wer-as-that-block-did-revm--webkit/error-context.md
> packages/webevm test:   2 failed
> packages/webevm test:     [chromium] › test/state-history.spec.ts:19:1 › point reads at any block in the stateHistory window answer as that block did (default engine)
> packages/webevm test:     [webkit] › test/revm-state-history.spec.ts:17:1 › point reads at any block in the stateHistory window answer as that block did (revm)
> packages/webevm test:   84 passed (47.4s)
> packages/webevm test: Failed
> /tmp/dorfl-fresh-gate-1AvsdE/tip/packages/webevm:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  webevm@0.7.0 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
