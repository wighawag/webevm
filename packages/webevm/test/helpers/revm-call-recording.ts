/**
 * revm-call-recording.ts: `webevm/revm` and the declared call-recording
 * capability (ADR 0018). Until the engine moves onto revm-wasm outcome format 5
 * (`console-log-on-the-revm-engine`), it does NOT declare `recordsCalls`, and it
 * says why, from the artifact it loaded, so a console-logging node's refusal
 * names what is missing. Driven at the seam: `connectEngine` directly, with
 * recording required, then without; and through `createNode({consoleLog})`.
 */
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createRevmEngine} from '../../src/revm.js';
import {connectEngine} from '../../src/engine.js';
import {createNode} from '../../src/node.js';
import {consoleLog} from '../../src/console-log.js';
import {OverlayStorageStateManager} from '../../src/state-manager.js';
import type {EngineContext} from '../../src/types.js';

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
		await p;
		return 'CONNECTED';
	} catch (e) {
		return `REFUSED: ${String((e as Error)?.message ?? e)}`;
	}
}

export async function runRevmCallRecordingChecks(wasm: Uint8Array) {
	const engine = await createRevmEngine({wasm});
	const declared = engine.recordsCalls;
	const required = await outcomeOf(
		connectEngine(engine, context(), {recordCalls: true}),
	);
	// The refusal happened BEFORE `connect`, so the same engine is still unbound
	// and connects to a node that does not require recording (an engine binds
	// to one node and refuses a second, so a refusal that had bound it would
	// show up here).
	const notRequired = await outcomeOf(connectEngine(engine, context()));
	// ...and through the public surface: a console-logging node on this engine
	// is refused AT CONSTRUCTION (ADR 0018), with the same words.
	const node = await outcomeOf(
		createNode({
			engine: await createRevmEngine({wasm}),
			consoleLog: consoleLog(),
		}),
	);
	return {
		node,
		engineId: engine.id,
		declared: declared === undefined ? 'ABSENT' : declared,
		required,
		notRequired,
	};
}
