/**
 * cut.ts — the code-under-test the playwright-browser-harness loads into a real
 * browser page for the LIBRARY's own correctness/conformance tests. It dispatches
 * on `params.mode` and returns structured `{results, timings, errors, env}`.
 *
 * Modes (one per library test):
 *   - 'slim-node-checks'   : legacy/1559 receipts, honest -32601 gaps, dump/load,
 *                            state-root mode (none throws / trie real root)
 *   - 'storage-overlay'    : `stateMode:'none'` storage is per-account with a
 *                            per-checkpoint OVERLAY — checkpoint/commit/revert
 *                            semantics against a naive control, a randomised
 *                            differential against the flat layout the node used
 *                            to ship, and the serialised dumpState format
 *   - 'engine-seam'        : the read path runs on an ENGINE — default
 *                            @ethereumjs/evm, injected engine serves all three
 *                            read-path callers, transactions stay on the VM
 *   - 'rpc-block'          : the RPC block and the EVM describe the SAME block
 *                            (miner / mixHash / logsBloom), on both sides of a
 *                            dumpState/loadState round trip, plus an old dump
 *   - 'concurrency'        : TWO EXECUTIONS AT ONCE must not destroy each other's
 *                            state — deterministic tick-offset scans of a read
 *                            overlapping a write, two writes overlapping, state
 *                            torn at a message-frame boundary, an `eth_call`
 *                            committing its OWN write, a non-executing read going
 *                            dirty mid-transaction, and the serialisation point
 *                            not waiting for itself
 *   - 'estimate-gas'       : `eth_estimateGas` answers with the smallest gas LIMIT
 *                            at which the request succeeds (a deployment through
 *                            the CREATE2 factory mines at it, and fails one gas
 *                            below), the common cases stay un-inflated, and what
 *                            cannot succeed at any limit is an ERROR
 *
 * `webevm/revm` has its OWN cut (./cut-revm.ts), because its bundle
 * carries the revm `.wasm` asset and no other spec should pay for it.
 *   - 'trusted-sender'     : senderMode:'trusted' (skip ecrecover) is byte-identical
 *                            to 'recover', the cheat is absent by default, and a tx
 *                            claiming a sender its signature does not recover to
 *                            executes as the CLAIMED one. ENGINE-PARAMETERISED: the
 *                            same suite runs on revm through ./cut-revm.ts
 *   - 'conformance'        : differential vs a trie-backed @ethereumjs/vm runTx
 *   - 'statetest'          : real ethereum/tests GeneralStateTests vs trie mode
 *   - 'viem-surface'       : a typical viem/wagmi lifecycle + method-gap report
 *   - 'genesis-cheats-perf': custom genesis + evm_set* cheats + trie-vs-none perf.
 *                            ENGINE-PARAMETERISED: the genesis + cheats halves run
 *                            on revm through ./cut-revm.ts
 *   - 'state-roundtrip'    : the cheats and dumpState/loadState ACROSS a transaction
 *                            boundary. ENGINE-PARAMETERISED: the same suite runs on
 *                            revm through ./cut-revm.ts
 *   - 'persist-reload'     : IndexedDB persistence + eth_getLogs across a reload.
 *                            ENGINE-PARAMETERISED: the same suite runs on revm
 *                            through ./cut-revm.ts
 *   - 'worker'             : the comlink Worker wrapper (same API, non-blocking)
 *   - 'engine-misuse'      : a worker module that hands `exposeNode()` an ENGINE
 *                            where the FACTORY belongs: the main thread must get
 *                            a REJECTION carrying the reason, never a promise that
 *                            never settles, and the worker must say so early too
 *
 * The cross-backend PERFORMANCE benchmark (vs raw @ethereumjs/* and tevm) lives in
 * the separate `webevm-benchmarks` package, so this library package's
 * devDependencies stay free of tevm and the benchmark toolchain.
 */
import type {
	CodeUnderTest,
	RunResult,
	Timing,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {slimNodeHonestyChecks} from './slim-node-checks.js';
import {runStorageOverlayChecks} from './storage-overlay.js';
import {runEngineSeamChecks} from './engine-seam.js';
import {runRpcBlockChecks} from './rpc-block.js';
import {runEstimateGasChecks} from './estimate-gas.js';
import {runConcurrencyChecks} from './concurrency.js';
import {runTrustedSenderChecks} from './trusted-sender.js';
import {workerRoundtrip} from './worker-roundtrip.js';
import {driveMisusedEngineWorker, reportEarlySignal} from './engine-misuse.js';
import {runConformance} from './conformance.js';
import {viemSurfaceProbe} from './viem-surface.js';
import {runStateTests} from './statetest.js';
import {runGenesisCheatsPerf} from './genesis-cheats-perf.js';
import {runStateRoundTrip} from './state-roundtrip.js';
import {persistWrite, persistRead} from './persistence-reload.js';

const cut: CodeUnderTest = {
	name: 'webevm',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const timings: Timing[] = [];
		const results: Record<string, unknown> = {};

		// slim-node-checks: legacy + 1559 receipts, honest method-not-found gaps,
		// dump/load persistence round-trip, and the state-root mode behaviour.
		if (ctx.params.mode === 'slim-node-checks') {
			try {
				results.slimNodeChecks = await slimNodeHonestyChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// storage-overlay: the `stateMode:'none'` storage representation. Correctness
		// FIRST (semantics + a randomised differential against the layout the node
		// shipped before, with the plausible wrong version kept as a control that must
		// fail them), then the readers, then the serialised dumpState format.
		if (ctx.params.mode === 'storage-overlay') {
			try {
				results.storageOverlay = await runStorageOverlayChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// engine-seam: the node's READ path (eth_call / eth_estimateGas /
		// eth_fillTransaction) runs on an injected engine, defaulting to
		// @ethereumjs/evm with its pure-read checkpoint + EIP-2929 reset intact.
		if (ctx.params.mode === 'engine-seam') {
			try {
				results.engineSeam = await runEngineSeamChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// rpc-block: the block header a consumer READS says what the block the EVM
		// RAN actually was — coinbase, prevRandao and the logs bloom — and goes on
		// saying it after a dumpState/loadState round trip, including for a state
		// dumped by the previous version.
		if (ctx.params.mode === 'rpc-block') {
			try {
				results.rpcBlock = await runRpcBlockChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// estimate-gas: the number `eth_estimateGas` returns is a gas LIMIT that
		// works, found by re-executing the request, rather than the gas the request
		// CONSUMES — which EIP-150's 63/64 rule makes unusable for anything with a
		// sub-call or an inner create.
		if (ctx.params.mode === 'estimate-gas') {
			try {
				results.estimateGas = await runEstimateGasChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// concurrency: the node serialises its whole public surface, so two requests
		// in flight cannot pop each other's checkpoint levels off the ONE state
		// manager they share. Deterministic tick-offset scans, one fresh node per
		// offset — a test that only SOMETIMES overlaps would be worthless here.
		if (ctx.params.mode === 'concurrency') {
			try {
				results.concurrency = await runConcurrencyChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// trusted-sender: prove senderMode:'trusted' (ecrecover skipped) produces
		// receipts + post-state IDENTICAL to the authenticated 'recover' path, that
		// the cheat methods do not exist in the default mode, and that trusted mode
		// really does let a caller impersonate.
		if (ctx.params.mode === 'trusted-sender') {
			try {
				results.trustedSender = await runTrustedSenderChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// persist-reload: prove IndexedDB persistence + eth_getLogs survive a REAL
		// page reload. phase 'write' builds + persists; the test reloads the page
		// (wiping JS state); phase 'read' creates a fresh node that auto-loads from
		// IndexedDB and re-queries everything (incl. eth_getLogs).
		if (ctx.params.mode === 'persist-reload') {
			try {
				if (ctx.phase === 'write') {
					results.write = await persistWrite();
				} else {
					results.read = await persistRead(String(ctx.params.address));
				}
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// state-roundtrip: the state-owning features ACROSS a transaction boundary —
		// the four evm_set* cheats applied BETWEEN two transactions and observed by the
		// execution of the next one, and a dumpState taken AFTER a transaction reloaded
		// into a fresh node that then keeps behaving identically.
		if (ctx.params.mode === 'state-roundtrip') {
			try {
				results.stateRoundTrip = await runStateRoundTrip();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// genesis/cheats/perf: custom genesis (initialState), runtime evm_set*
		// cheats, and a trie-vs-none perf comparison.
		if (ctx.params.mode === 'genesis-cheats-perf') {
			try {
				results.genesisCheatsPerf = await runGenesisCheatsPerf();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// statetest (track B): real ethereum/tests GeneralStateTests against
		// stateMode:'trie' — assert the post-state root + logs hash match.
		if (ctx.params.mode === 'statetest') {
			try {
				const fixtures = ctx.params.fixtures as {name: string; json: any}[];
				results.stateTests = await runStateTests(fixtures);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// viem-surface: drive the node through a typical viem/wagmi lifecycle and
		// report which EIP-1193 methods were exercised + which are unsupported.
		if (ctx.params.mode === 'viem-surface') {
			try {
				results.viemSurface = await viemSurfaceProbe();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// conformance: differential test the node's receipt/RPC layer against a
		// trie-backed @ethereumjs/vm runTx reference over a battery of signed txs,
		// for BOTH state modes. Returns per-step mismatch reports.
		if (ctx.params.mode === 'conformance') {
			try {
				const out = await runConformance();
				results.conformance = out;
				results.conformanceTotalMismatches =
					out.none.totalMismatches + out.trie.totalMismatches;
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// worker: prove the comlink Worker wrapper works (same API) and that the
		// main thread stays non-blocking while the Worker computes.
		if (ctx.params.mode === 'worker') {
			try {
				const out = await workerRoundtrip(
					String(ctx.params.workerUrl),
					Number(ctx.params.sumTo ?? 200000),
				);
				results.number = out.number;
				results.engineId = out.engineId;
				// Every plain field the worker-host proxy must forward, read back
				// through comlink so an omission fails here instead of silently
				// reading `undefined` in a consumer.
				results.senderMode = out.senderMode;
				results.stateMode = out.stateMode;
				// ...and the same question with NO field named: every key a main-thread
				// node has, compared across the boundary, so a field added to `SlimNode`
				// later is covered without anybody remembering to add it here.
				results.shapeGaps = out.shapeGaps;
				results.mainThreadSampleCount = out.mainThreadSampleCount;
				timings.push({label: 'workerRoundtripAvg', ms: out.roundtripAvgMs});
				timings.push({label: 'mainThreadMaxGap', ms: out.mainThreadMaxGapMs});
				timings.push({label: 'workerCompute', ms: out.workerComputeMs});
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// engine-misuse: the same Worker path, driven by a worker module that misuses
		// `createEngine`. What is under test is what the MAIN THREAD gets: the refusal
		// used to throw during the worker module's evaluation, so `expose()` never ran
		// and `createWorkerNode()` never settled at all.
		if (ctx.params.mode === 'engine-misuse') {
			try {
				results.mainThread = await driveMisusedEngineWorker(
					String(ctx.params.workerUrl),
				);
				// ...and the worker's own half, on the value THIS bundle's worker module
				// passes: an engine-shaped object, i.e. the non-promise branch of the
				// message.
				results.early = reportEarlySignal({id: 'pretend-engine'});
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		return {
			results: {},
			timings: [],
			errors: [`unknown mode: ${String(ctx.params.mode)}`],
			env: captureEnv(),
		};
	},
};

export default cut;
