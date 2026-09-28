/**
 * webevm — a slim, execution-only EIP-1193 Ethereum node
 * on @ethereumjs/vm. Transport-agnostic core: just an async `request()` +
 * mine/dumpState/loadState. Optional comlink Worker helpers are in ./worker-host
 * and ./worker-entry (Worker side) and ./worker-client (main-thread side) so the
 * core never imports comlink.
 */
export {createNode} from './node.js';
export {
	createIndexedDBPersistence,
	createMemoryPersistence,
} from './persistence.js';
export type {
	SlimNode,
	ServedPort,
	NodeOptions,
	MiningConfig,
	StateMode,
	SenderMode,
	StateHistoryOptions,
	// The engine seam: implement `Engine` to put a different EVM behind the node —
	// its reads (`call`) and its transactions (`transact`). Types only, so the core
	// never imports a non-default engine.
	Engine,
	EngineContext,
	EngineInfo,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
	TransactionLog,
	GenesisAccount,
	BlockEnv,
	PersistenceAdapter,
	RequestArguments,
	SerializedState,
	SerializedHistoryBlock,
} from './types.js';
export {RpcError} from './types.js';
// The revm engine is intentionally NOT re-exported here either, for the same
// reason: the core must import no engine a consumer did not. Import it directly:
//   import {createRevmEngine} from 'webevm/revm';
// Worker helpers are intentionally NOT re-exported here to keep comlink out of
// the core bundle. Import them directly:
//   import {createWorkerNode} from 'webevm/worker-client';
//   new Worker(new URL('webevm/worker-entry', import.meta.url));
// ...and, for a Worker that must build its own engine (an engine cannot cross the
// boundary), your own worker module:
//   import {exposeNode} from 'webevm/worker-host';
