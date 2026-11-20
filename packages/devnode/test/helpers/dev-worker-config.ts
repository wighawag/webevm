/**
 * dev-worker-config.ts: what ./dev-worker.ts writes into its dev config, shared
 * with the page (./worker-hosting-checks.ts) WITHOUT importing the worker module
 * itself, whose import would run `exposeDevNode()` on the page.
 *
 * The page knows the mnemonic only to look for it: everything it RECEIVES from
 * the worker is searched for this phrase and for every key derived from it.
 */
export const WORKER_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const WORKER_ACCOUNT_COUNT = 3;
