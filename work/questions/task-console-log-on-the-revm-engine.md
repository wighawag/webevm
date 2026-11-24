<!-- dorfl-sidecar: item=task:console-log-on-the-revm-engine type=task slug=console-log-on-the-revm-engine allAnswered=false -->

## Q1

**'task:console-log-on-the-revm-engine' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build && pnpm test`; its last output was:
>
> packages/webevm test:     Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m
> packages/webevm test:     Expected: [32m0[39m
> packages/webevm test:     Received: [31m2[39m
> packages/webevm test:       65 | 	// message crossed the page's handles on either worker. The page relays nothing.
> packages/webevm test:       66 | 	expect(fromWorker.answeredWhilePageFree).toBeGreaterThan(10);
> packages/webevm test:     > 67 | 	expect(fromWorker.pageMessagesWhileServing).toBe(0);
> packages/webevm test:          | 	                                            ^
> packages/webevm test:       68 | 	expect(fromWorker.pageMessagesBefore).toBeGreaterThan(0);
> packages/webevm test:       69 | 	expect(fromWorker.loopResults).toEqual([CHAIN_ID_HEX]);
> packages/webevm test:       70 | 	// ...and on Chromium, the stronger form: answers kept coming while the page's
> packages/webevm test:         at /tmp/dorfl-fresh-gate-4x4XPG/tip/packages/webevm/test/serve-on-port.spec.ts:67:46
> packages/webevm test:     Error Context: test-results/serve-on-port-a-node-serve-f803f-osted-and-main-thread-alike-chromium/error-context.md
> packages/webevm test:   1 failed
> packages/webevm test:     [chromium] › test/serve-on-port.spec.ts:42:1 › a node serves EIP-1193 on a handed MessagePort, worker-hosted and main-thread alike
> packages/webevm test:   139 passed (2.1m)
> packages/webevm test: Failed
> /tmp/dorfl-fresh-gate-4x4XPG/tip/packages/webevm:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  webevm@0.10.0 test: `playwright test`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
