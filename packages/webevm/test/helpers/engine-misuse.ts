/**
 * engine-misuse.ts: runs in the browser PAGE. Asks the one question a misuse of
 * `exposeNode({createEngine})` used to answer with SILENCE: what does the MAIN
 * THREAD see when a worker module passes something that is not a factory?
 *
 * THE FAILURE THIS EXISTS TO CATCH IS A NON-EVENT, so it is measured with a
 * budget rather than with a `try`/`catch`. The refusal used to THROW while the
 * worker module was still evaluating, which meant `expose()` never ran, the
 * worker registered no message listener, and `createWorkerNode()` stayed pending
 * FOREVER: no error, no rejection, nothing to catch, and the explanation reaching
 * only the worker's console. `outcome` therefore distinguishes three endings,
 * `REJECTED` (what a caller can act on), `DID_NOT_THROW` (the misuse was
 * accepted) and `NEVER_SETTLED` (the hang), so a regression back to the hang
 * reads as the third rather than as a red timeout with no diagnosis.
 *
 * The SECOND half is the worker's own signal. The main thread's rejection is the
 * late one, by construction: it arrives when somebody asks for a node. The early
 * one is `createNodeWorkerApi()` reporting the mistake at the moment it is made,
 * on the thread that made it, which is what a developer with the worker console
 * open sees first. Both are asserted, because keeping only one of them was the
 * fork this task's steer closed: neither thread should be left guessing.
 */
import {createWorkerNode} from '../../src/worker-client.js';
import {createNodeWorkerApi} from '../../src/worker-host.js';

const CHAIN_ID = 31337;

/** How long a hang is given to prove it is one. */
const SETTLE_BUDGET_MS = 10_000;

export interface MisusedWorkerReport {
	/** What the main thread's `createWorkerNode()` promise DID. */
	outcome: 'REJECTED' | 'DID_NOT_THROW' | 'NEVER_SETTLED';
	/** The rejection's message, verbatim, or '' when it never rejected. */
	message: string;
	/** How long it took to get there (reported, never asserted). */
	elapsedMs: number;
}

/**
 * Drive a worker module that misuses `createEngine` through the ORDINARY client,
 * exactly as a consumer would, and report what the main thread got.
 */
export async function driveMisusedEngineWorker(
	workerUrl: string,
	budgetMs: number = SETTLE_BUDGET_MS,
): Promise<MisusedWorkerReport> {
	const worker = new Worker(workerUrl, {type: 'module'});
	const started = performance.now();
	let outcome: MisusedWorkerReport['outcome'] = 'NEVER_SETTLED';
	let message = '';
	let elapsedMs = budgetMs;

	const settled = createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	}).then(
		async (node) => {
			outcome = 'DID_NOT_THROW';
			elapsedMs = performance.now() - started;
			// The misuse was ACCEPTED, which is its own failure; leave nothing
			// running behind it.
			await node.dispose();
		},
		(err: unknown) => {
			outcome = 'REJECTED';
			message = String((err as Error)?.message ?? err);
			elapsedMs = performance.now() - started;
		},
	);

	await Promise.race([
		settled,
		new Promise<void>((resolve) => setTimeout(resolve, budgetMs)),
	]);
	// Terminate either way: on the hang the worker is still sitting there, and on
	// the rejection `dispose()` was never reached (there is no node to dispose).
	worker.terminate();
	return {outcome, message, elapsedMs};
}

export interface EarlySignalReport {
	/** Everything `createNodeWorkerApi()` reported to the console, joined. */
	reported: string;
	/** 'DID_NOT_THROW', or the message it threw (a throw here IS the hang). */
	threw: string;
}

/**
 * The WORKER-side half, exercised on whichever thread runs it (the function is
 * the same one a worker module calls). Two things must hold at once and they pull
 * in opposite directions:
 *
 *   - it REPORTS the mistake immediately, so the developer sees it at the moment
 *     it is made rather than only when a node is asked for;
 *   - it does NOT THROW, because a throw here happens while the worker module is
 *     still evaluating, so `expose()` never runs and the main thread has nothing
 *     to receive a rejection FROM. That is the hang, in one line.
 */
export function reportEarlySignal(badCreateEngine: unknown): EarlySignalReport {
	return reportHostOptionsEarlySignal({createEngine: badCreateEngine});
}

/**
 * The same worker-side half for ANY host options, so a misused `createNode`
 * factory (`./node-factory.ts`) is held to the same two properties.
 */
export function reportHostOptionsEarlySignal(
	hostOptions: Record<string, unknown>,
): EarlySignalReport {
	const lines: string[] = [];
	const realError = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(' '));
	};
	let threw = 'DID_NOT_THROW';
	try {
		createNodeWorkerApi(hostOptions as never);
	} catch (e) {
		threw = String((e as Error)?.message ?? e);
	} finally {
		console.error = realError;
	}
	return {reported: lines.join('\n'), threw};
}
