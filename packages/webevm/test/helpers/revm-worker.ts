/**
 * revm-worker.ts: THE CONSUMER'S OWN WORKER MODULE, and the file the README
 * points a reader at. It is test-suite code only in that it lives here and is
 * executed on every run; nothing in it is test-shaped, and it is the whole of
 * what an application writes to host a revm-backed node in a Worker.
 *
 * WHY A CONSUMER WRITES THIS FILE AT ALL. `createWorkerNode({engine})` is
 * refused: the node's options are structured-cloned into the Worker and an
 * `Engine` is a function-bearing object holding thread-bound live state (a wasm
 * instance, a binding to that thread's state manager), so cloning one could not
 * work even in principle. And the package's own `webevm/worker-entry`
 * deliberately does NOT build engines for you. That would mean the core naming
 * engines by string and importing them, which
 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` refuses,
 * and a JS-only consumer would then pay for revm they never asked for. So the
 * engine is built HERE, on the thread that will use it, by the code that wants
 * it, and `exposeNode()` supplies everything that is NOT engine-specific,
 * because that part is identical for every consumer and used to be hand-copied
 * (the `SlimNode` proxy now lives in exactly one place, `src/worker-host.ts`).
 *
 * WHAT THE MAIN THREAD DOES WITH IT: nothing special. `exposeNode()` exposes the
 * same `{createNode(options)}` API `worker-entry` does, so the ordinary client
 * drives it unchanged and the consumer never hand-rolls comlink on their side:
 *
 *   const worker = new Worker(new URL('./revm-worker.ts', import.meta.url),
 *                             {type: 'module'});
 *   const node = await createWorkerNode({worker, chainId: 31337, ...});
 *   node.engine.id;  // 'revm-wasm'
 *
 * The main thread's options (`chainId`, `miningConfig`, `initialBalances`, ...)
 * still travel through `createWorkerNode()` untouched; only the ENGINE is this
 * thread's business, and `createEngine` is called ONCE PER NODE because one
 * engine instance serves one node.
 *
 * IMPORTED BY PACKAGE NAME (`webevm/worker-host`,
 * `webevm/revm`) and not by relative `src/` path, unlike every other
 * helper here, because a consumer resolves them that way: this module therefore
 * also exercises the published export map, as `packages/benchmarks` already does.
 *
 * THE WASM, delivered as a BUNDLER-RESOLVED asset: the build resolves it out of
 * the `revm-wasm` package and puts the bytes IN the worker bundle, so the Worker
 * fetches nothing and no path is hard-coded (esbuild's `binary` loader here;
 * Vite's `?arraybuffer`, webpack's `asset/inline`). The runtime-fetched-URL shape
 * works here too (pass `{wasm: new URL(...)}`) and is what a consumer who does
 * not want 1.17 MB inside their worker chunk reaches for; `revm-engine.spec.ts`
 * covers both shapes on the main thread, and this module deliberately covers the
 * one that has to survive being bundled a SECOND time, as a Worker entry point.
 *
 * `computeStateRoot` is left to the caller, and revm serves it either way (ADR
 * 0014). Anything revm REFUSES at `createNode()` (a hardfork it cannot cost, ADR
 * 0008) crosses the thread boundary unchanged: the refusal simply happens in
 * here, and comlink reports it to the caller of `createWorkerNode()`.
 */
import {exposeNode} from 'webevm/worker-host';
import {createRevmEngine} from 'webevm/revm';
import revmWasm from 'revm-wasm/revm.wasm';

// The whole of it: the engine is CONSTRUCTED on this thread, so nothing about it
// ever has to cross the boundary, and everything that is not the engine is the
// package's own.
export const revmWorkerApi = exposeNode({
	createEngine: () => createRevmEngine({wasm: revmWasm}),
});
