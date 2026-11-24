/**
 * revm-call-recording.ts: `webevm/revm` and call recording (ADR 0018), on
 * revm-wasm outcome format 5 (`recordCallsTo` in, `recordedCalls` out).
 *
 *   1. The engine DECLARES `recordsCalls: true` on an artifact of format 5 or
 *      later, and `connectEngine` requiring it connects.
 *   2. The seam's recording scenario (./engine-call-recording.ts) on revm AND on
 *      the default engine, for the same fixture, so the spec can hold both to
 *      the SAME recorded lists: every call kind including a DELEGATECALL into
 *      the address, frames in a reverting sub-call, a transaction that reverts
 *      as a whole, a CREATE (never recorded); and gas identity on revm.
 *   3. An artifact BELOW format 5 (./revm-outcome-format.ts) is refused at
 *      construction on a console-logging node, the engine's own reason naming
 *      the format it has and the one it needs, and keeps connecting to a node
 *      that does not log.
 *   4. `createNode({engine: <webevm/revm>, consoleLog})` is built.
 */
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createRevmEngine} from '../../src/revm.js';
import {connectEngine} from '../../src/engine.js';
import {createNode} from '../../src/node.js';
import {consoleLog} from '../../src/console-log.js';
import {OverlayStorageStateManager} from '../../src/state-manager.js';
import type {EngineContext} from '../../src/types.js';
import {runCallRecordingScenarios} from './engine-call-recording.js';
import {withOutcomeFormat} from './revm-outcome-format.js';

function context(): EngineContext {
	return {
		stateManager: new OverlayStorageStateManager(),
		common: new Common({
			chain: {...Mainnet, chainId: 31337, name: 'webevm'},
			hardfork: Hardfork.Osaka,
		}),
		getBlockHash: () => undefined,
	};
}

async function outcomeOf(p: Promise<unknown>): Promise<string> {
	try {
		const v = await p;
		if (v && typeof (v as {dispose?: unknown}).dispose === 'function')
			await (v as {dispose: () => Promise<void>}).dispose();
		return 'CONNECTED';
	} catch (e) {
		return `REFUSED: ${String((e as Error)?.message ?? e)}`;
	}
}

/** What the engine built over `wasm` declares, and how connect and the node treat it. */
async function declarationOf(wasm: Uint8Array | WebAssembly.Module) {
	const engine = await createRevmEngine({wasm});
	const declared = engine.recordsCalls;
	const required = await outcomeOf(
		connectEngine(engine, context(), {recordCalls: true}),
	);
	return {engineId: engine.id, declared: declared ?? 'ABSENT', required};
}

export async function runRevmCallRecordingChecks(bytes: Uint8Array) {
	const wasm = await WebAssembly.compile(bytes as BufferSource);

	// ---- 1. format 5: declared, and connected when required ----
	const current = await declarationOf(wasm);

	// ---- 2. the same scenario on both engines ----
	const revm = await runCallRecordingScenarios(() => createRevmEngine({wasm}));
	const reference = await runCallRecordingScenarios();

	// ---- 3. an artifact below format 5 ----
	const oldBytes = withOutcomeFormat(bytes, 4);
	const old = await declarationOf(oldBytes);
	// The refusal happened BEFORE `connect`, so a fresh engine on the old
	// artifact still connects to a node that does not require recording.
	const oldNotRequired = await outcomeOf(
		connectEngine(await createRevmEngine({wasm: oldBytes}), context()),
	);
	// ...and through the public surface: a console-logging node on it is
	// refused AT CONSTRUCTION (ADR 0018), with the same words, while a node
	// that does not log is built on the same artifact.
	const oldNode = await outcomeOf(
		createNode({
			engine: await createRevmEngine({wasm: oldBytes}),
			consoleLog: consoleLog(),
		}),
	);
	const oldNodeWithoutLogging = await outcomeOf(
		createNode({engine: await createRevmEngine({wasm: oldBytes})}),
	);

	// ---- 4. a console-logging node on the current artifact ----
	const node = await outcomeOf(
		createNode({
			engine: await createRevmEngine({wasm}),
			consoleLog: consoleLog({onLog: () => {}}),
		}),
	);

	return {
		current,
		revm,
		reference,
		old: {...old, notRequired: oldNotRequired, node: oldNode},
		oldNodeWithoutLogging,
		node,
	};
}
