/**
 * console-log-node.ts: Solidity `console.log` THROUGH THE NODE
 * (`createNode({consoleLog: consoleLog()})`), driven through the public surface
 * only: the fixture (`ConsoleLogProbe`, precompiled) deployed and called with
 * viem-signed transactions, entries read off `onConsoleLog` and the sink.
 *   1. every place a contract logs reaches the subscriber and the sink, with the
 *      decoded args, the message and the right `source`, and a `'transaction'`
 *      entry names the transaction, its block and its index; under automine,
 *      `mine()`, `evm_mine` and interval mining; several transactions in one
 *      block in order; a reverting `eth_call` still delivers
 *   2. the default sink prints once, prefixed; `onLog` replaces it; subscribers
 *      get entries whatever the sink; unsubscribe and `dispose()` stop them
 *   3. gas and outcome identity on and off (receipts, return data, state root,
 *      `eth_estimateGas`), and estimation delivers nothing
 *   4. a throwing sink, a throwing subscriber and a rejecting one change nothing
 *      and are reported once each through `console.error`; malformed console
 *      calldata delivers nothing and fails nothing
 *   5. a node without the option: `onConsoleLog` throws naming it; a bad option
 *      is refused at construction
 *   6. an engine declaring `recordsCalls` but omitting `recordedCalls` makes the
 *      request throw
 *   7. not chain state: no log in a dump, none replayed by `loadState` or a
 *      persistence reload
 *   8. a `createWorkerNode()` node's `onConsoleLog` throws synchronously
 * The re-entrancy case is in ./concurrency.ts, beside `onNewHead`'s. See
 * docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {createNode} from '../../src/node.js';
import {createMemoryPersistence} from '../../src/persistence.js';
import {createWorkerNode} from '../../src/worker-client.js';
import {consoleLog, type ConsoleLogEntry} from '../../src/console-log.js';
import type {
	Engine,
	NodeOptions,
	ReadCallResult,
	SlimNode,
	TransactionResult,
} from '../../src/types.js';
import {encodeFunctionData, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	consoleLogProbeAbi,
	consoleLogProbeBytecode,
} from './console-log-probe.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
/** Pinned, so two nodes (logging on and off) mine byte-identical blocks. */
const PINNED_TIME = 1_800_000_000n;

/** An entry as it can cross back to the spec: bigints as decimal strings. */
export type PlainEntry = Omit<ConsoleLogEntry, 'args'> & {args: unknown[]};

function plain(e: ConsoleLogEntry): PlainEntry {
	return {
		...e,
		args: e.args.map((a) => (typeof a === 'bigint' ? `${a}n` : a)),
	} as PlainEntry;
}

/** A node plus a signer and the fixture's calls, all through `request`. */
function client(node: SlimNode) {
	let nonce = 0;
	async function send(to: Hex | null, data: Hex, gas = 1_000_000n) {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: nonce++,
			...(to ? {to} : {}),
			data,
			gas,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		});
		return (await node.request({
			method: 'eth_sendRawTransaction',
			params: [raw],
		})) as Hex;
	}
	async function receipt(hash: Hex) {
		return (await node.request({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		})) as any;
	}
	const data = {
		work: (n: bigint) =>
			encodeFunctionData({
				abi: consoleLogProbeAbi,
				functionName: 'work',
				args: [n],
			}),
		failWhole: (why: string) =>
			encodeFunctionData({
				abi: consoleLogProbeAbi,
				functionName: 'failWhole',
				args: [why],
			}),
		peek: (who: Hex) =>
			encodeFunctionData({
				abi: consoleLogProbeAbi,
				functionName: 'peek',
				args: [who],
			}),
		malformed: () =>
			encodeFunctionData({abi: consoleLogProbeAbi, functionName: 'malformed'}),
	};
	return {
		node,
		send,
		receipt,
		data,
		async deploy(): Promise<{hash: Hex; address: Hex}> {
			const hash = await send(null, consoleLogProbeBytecode);
			return {hash, address: (await receipt(hash)).contractAddress};
		},
		call(to: Hex, input: Hex) {
			return node.request({
				method: 'eth_call',
				params: [{from: account.address, to, data: input}, 'latest'],
			}) as Promise<Hex>;
		},
		estimate(to: Hex, input: Hex) {
			return node.request({
				method: 'eth_estimateGas',
				params: [{from: account.address, to, data: input}],
			}) as Promise<Hex>;
		},
	};
}

function nodeOptions(extra: Partial<NodeOptions> = {}): NodeOptions {
	return {
		chainId: CHAIN_ID,
		initialBalances: {[account.address]: 10n ** 24n},
		...extra,
	};
}

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		return `OK ${JSON.stringify(await p)}`;
	} catch (e) {
		return `THREW ${String((e as Error)?.message ?? e)}`;
	}
}

function syncOutcome(f: () => unknown): string {
	try {
		f();
		return 'OK';
	} catch (e) {
		return `THREW ${String((e as Error)?.message ?? e)}`;
	}
}

/** Swap `console[method]` for a recorder while `run` runs. */
async function capturing<T>(
	method: 'log' | 'error',
	run: () => Promise<T>,
): Promise<{out: T; calls: unknown[][]}> {
	const original = console[method];
	const calls: unknown[][] = [];
	console[method] = (...args: unknown[]) => {
		calls.push(args);
	};
	try {
		const out = await run();
		// a rejected promise is reported a microtask (or more) later
		await new Promise((r) => setTimeout(r, 20));
		return {out, calls};
	} finally {
		console[method] = original;
	}
}

/** 1. every place a contract logs, under automine. */
async function automine() {
	const sunk: PlainEntry[] = [];
	const node = await createNode(
		nodeOptions({consoleLog: consoleLog({onLog: (e) => sunk.push(plain(e))})}),
	);
	const c = client(node);
	const got: PlainEntry[] = [];
	node.onConsoleLog((e) => got.push(plain(e)));
	const at = () => got.length;
	const step = async <T>(run: () => Promise<T>) => {
		const from = at();
		const out = await run();
		return {out, entries: got.slice(from)};
	};
	try {
		const deploy = await step(() => c.deploy());
		const deployReceipt = await c.receipt(deploy.out.hash);
		const probe = deploy.out.address;
		const work = await step(() => c.send(probe, c.data.work(5n)));
		const workReceipt = await c.receipt(work.out);
		// explicit gas: no estimation, so the revert is mined
		const failWhole = await step(() =>
			c.send(probe, c.data.failWhole('nope'), 300_000n),
		);
		const failWholeReceipt = await c.receipt(failWhole.out);
		const peek = await step(() => c.call(probe, c.data.peek(account.address)));
		const revertingCall = await step(() =>
			outcome(c.call(probe, c.data.failWhole('in a read'))),
		);
		const estimate = await step(() => c.estimate(probe, c.data.work(1n)));
		const malformed = await step(() =>
			c.send(probe, c.data.malformed(), 300_000n),
		);
		const malformedReceipt = await c.receipt(malformed.out);
		const countAfter = await c.call(
			probe,
			encodeFunctionData({abi: consoleLogProbeAbi, functionName: 'count'}),
		);
		return {
			sender: account.address,
			probe,
			deploy: {
				entries: deploy.entries,
				hash: deploy.out.hash,
				blockNumber: Number(deployReceipt.blockNumber),
				blockHash: deployReceipt.blockHash,
				txIndex: Number(deployReceipt.transactionIndex),
			},
			work: {
				entries: work.entries,
				hash: work.out,
				blockNumber: Number(workReceipt.blockNumber),
				blockHash: workReceipt.blockHash,
				status: workReceipt.status,
				eventLogs: workReceipt.logs.length,
			},
			failWhole: {
				entries: failWhole.entries,
				hash: failWhole.out,
				status: failWholeReceipt.status,
				blockHash: failWholeReceipt.blockHash,
			},
			peek: {entries: peek.entries, result: peek.out},
			revertingCall: {
				entries: revertingCall.entries,
				outcome: revertingCall.out,
			},
			estimate: {entries: estimate.entries},
			malformed: {
				entries: malformed.entries,
				status: malformedReceipt.status,
			},
			countAfter,
			// the sink got exactly what the subscriber got
			sinkMatchesSubscriber: JSON.stringify(sunk) === JSON.stringify(got),
			total: got.length,
		};
	} finally {
		await node.dispose();
	}
}

/** 1. manual mining: several transactions in one `mine()`, then `evm_mine`. */
async function manual() {
	const node = await createNode(
		nodeOptions({
			miningConfig: {type: 'manual'},
			consoleLog: consoleLog({onLog: () => {}}),
		}),
	);
	const c = client(node);
	const got: PlainEntry[] = [];
	node.onConsoleLog((e) => got.push(plain(e)));
	try {
		const deployHash = await c.send(null, consoleLogProbeBytecode);
		const beforeDeployMine = got.length;
		await node.mine();
		const probe = (await c.receipt(deployHash)).contractAddress as Hex;
		got.length = 0;
		const hashes = [
			await c.send(probe, c.data.work(1n)),
			await c.send(probe, c.data.work(2n)),
			await c.send(probe, c.data.work(3n)),
		];
		const beforeMine = got.length;
		const mined = await node.mine();
		const batch = got.splice(0);
		const evmHash = await c.send(probe, c.data.work(10n));
		const beforeEvmMine = got.length;
		await node.request({method: 'evm_mine', params: []});
		const evmReceipt = await c.receipt(evmHash);
		return {
			beforeDeployMine,
			beforeMine,
			hashes,
			mined: {blockNumber: mined.blockNumber, blockHash: mined.blockHash},
			batch,
			beforeEvmMine,
			evmMine: {
				hash: evmHash,
				blockNumber: Number(evmReceipt.blockNumber),
				blockHash: evmReceipt.blockHash,
				entries: got.splice(0),
			},
		};
	} finally {
		await node.dispose();
	}
}

/** 1. interval mining. */
async function interval() {
	const node = await createNode(
		nodeOptions({
			miningConfig: {type: 'interval', intervalMs: 50},
			consoleLog: consoleLog({onLog: () => {}}),
		}),
	);
	const c = client(node);
	const got: PlainEntry[] = [];
	node.onConsoleLog((e) => got.push(plain(e)));
	const until = async (n: number) => {
		for (let i = 0; i < 200 && got.length < n; i++)
			await new Promise((r) => setTimeout(r, 25));
	};
	try {
		const deployHash = await c.send(null, consoleLogProbeBytecode);
		await until(1);
		const deployReceipt = await c.receipt(deployHash);
		return {
			hash: deployHash,
			blockNumber: Number(deployReceipt?.blockNumber),
			blockHash: deployReceipt?.blockHash,
			entries: got.slice(),
		};
	} finally {
		await node.dispose();
	}
}

/** 2. the default sink, `onLog`, unsubscribe and dispose. */
async function sinks() {
	// the default sink prints through console.log, prefixed, once per entry
	const printed = await capturing('log', async () => {
		const node = await createNode(nodeOptions({consoleLog: consoleLog()}));
		const got: PlainEntry[] = [];
		node.onConsoleLog((e) => got.push(plain(e)));
		const c = client(node);
		const {address} = await c.deploy();
		await c.send(address, c.data.work(7n));
		await node.dispose();
		return got;
	});
	// `onLog` replaces it: nothing printed
	const replaced = await capturing('log', async () => {
		const sunk: string[] = [];
		const node = await createNode(
			nodeOptions({
				consoleLog: consoleLog({onLog: (e) => sunk.push(e.message)}),
			}),
		);
		const got: string[] = [];
		node.onConsoleLog((e) => got.push(e.message));
		const c = client(node);
		const {address} = await c.deploy();
		// unsubscribe stops a subscriber, not the sink
		const second: string[] = [];
		const off = node.onConsoleLog((e) => second.push(e.message));
		await c.send(address, c.data.work(1n));
		off();
		await c.send(address, c.data.work(2n));
		// dispose drops every subscriber
		const third: string[] = [];
		node.onConsoleLog((e) => third.push(e.message));
		await node.dispose();
		const sunkBeforeAfterDispose = sunk.length;
		await c.send(address, c.data.work(3n));
		return {
			sunk,
			got,
			second,
			third,
			sunkAfterDispose: sunk.length - sunkBeforeAfterDispose,
		};
	});
	return {
		defaultSink: {
			entries: printed.out.map((e) => e.message),
			printed: printed.calls,
		},
		onLog: {...replaced.out, printed: replaced.calls.length},
	};
}

/** 3. gas and outcome identity, logging on and off. */
async function identity() {
	async function run(on: boolean) {
		const got: PlainEntry[] = [];
		const node = await createNode(
			nodeOptions({
				computeStateRoot: true,
				genesisTimestamp: PINNED_TIME,
				blockEnv: {timestamp: PINNED_TIME},
				...(on ? {consoleLog: consoleLog({onLog: () => {}})} : {}),
			}),
		);
		if (on) node.onConsoleLog((e) => got.push(plain(e)));
		const c = client(node);
		try {
			const {hash, address} = await c.deploy();
			const hashes = [
				hash,
				await c.send(address, c.data.work(4n)),
				await c.send(address, c.data.failWhole('x'), 300_000n),
				await c.send(address, c.data.malformed(), 300_000n),
			];
			const receipts = await Promise.all(hashes.map((h) => c.receipt(h)));
			const peek = await c.call(address, c.data.peek(account.address));
			const reverting = await outcome(c.call(address, c.data.failWhole('y')));
			const before = got.length;
			const estimate = await c.estimate(address, c.data.work(1n));
			const estimateEntries = got.length - before;
			return {
				receipts,
				peek,
				reverting,
				estimate,
				estimateEntries,
				stateRoot: await node.getStateRoot(),
				dump: await node.dumpState(),
				entries: got.length,
			};
		} finally {
			await node.dispose();
		}
	}
	const on = await run(true);
	const off = await run(false);
	const json = (v: unknown) =>
		JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
	return {
		receiptsIdentical: json(on.receipts) === json(off.receipts),
		receiptStatuses: on.receipts.map((r: any) => r.status),
		gasUsed: on.receipts.map((r: any) => r.gasUsed),
		peekOn: on.peek,
		peekOff: off.peek,
		revertingOn: on.reverting,
		revertingOff: off.reverting,
		estimateOn: on.estimate,
		estimateOff: off.estimate,
		estimateEntries: on.estimateEntries,
		stateRootOn: on.stateRoot,
		stateRootOff: off.stateRoot,
		// 7. not chain state: the dump of a logging node is the dump of a quiet one
		dumpsIdentical: json(on.dump) === json(off.dump),
		entriesOn: on.entries,
	};
}

/** 4. failing consumers change nothing and are each reported once. */
async function failures() {
	async function withConsumer(kind: 'sink' | 'subscriber' | 'rejecting') {
		return capturing('error', async () => {
			const node = await createNode(
				nodeOptions({
					consoleLog: consoleLog({
						onLog:
							kind === 'sink'
								? () => {
										throw new Error('the sink throws');
									}
								: () => {},
					}),
				}),
			);
			if (kind === 'subscriber')
				node.onConsoleLog(() => {
					throw new Error('the subscriber throws');
				});
			if (kind === 'rejecting')
				node.onConsoleLog((async () => {
					throw new Error('the subscriber rejects');
				}) as unknown as (e: ConsoleLogEntry) => void);
			// a well-behaved subscriber after the failing one still gets every entry
			const after: string[] = [];
			node.onConsoleLog((e) => after.push(e.message));
			const c = client(node);
			try {
				const {hash, address} = await c.deploy();
				const status = (await c.receipt(hash)).status;
				const peek = await c.call(address, c.data.peek(account.address));
				return {status, peek, after};
			} finally {
				await node.dispose();
			}
		});
	}
	const report = (r: Awaited<ReturnType<typeof withConsumer>>) => ({
		...r.out,
		errors: r.calls.length,
		messages: r.calls.map((args) =>
			args.map((a) => String((a as Error)?.message ?? a)).join(' | '),
		),
	});
	return {
		sink: report(await withConsumer('sink')),
		subscriber: report(await withConsumer('subscriber')),
		rejecting: report(await withConsumer('rejecting')),
	};
}

/** 5. a node without the option, and a bad option. */
async function without() {
	const node = await createNode(nodeOptions());
	const c = client(node);
	try {
		const onConsoleLog = syncOutcome(() => node.onConsoleLog(() => {}));
		const {hash} = await c.deploy();
		return {
			onConsoleLog,
			deployStatus: (await c.receipt(hash)).status,
			refusedFlag: await outcome(
				createNode(nodeOptions({consoleLog: true as any})),
			),
			refusedFunction: await outcome(
				createNode(nodeOptions({consoleLog: consoleLog as any})),
			),
		};
	} finally {
		await node.dispose();
	}
}

/** 6. an engine that declares the capability and returns no `recordedCalls`. */
async function lyingEngine() {
	const engine: Engine = {
		id: 'test-records-nothing',
		recordsCalls: true,
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact(): Promise<TransactionResult> {
			return {
				status: 1,
				gasUsed: 21_000n,
				effectiveGasPrice: 1_000_000_000n,
				logs: [],
				logsBloom: new Uint8Array(256),
			};
		},
	};
	const node = await createNode(
		nodeOptions({engine, consoleLog: consoleLog({onLog: () => {}})}),
	);
	const c = client(node);
	try {
		return {
			call: await outcome(c.call(account.address, '0x')),
			send: await outcome(c.send(account.address, '0x', 21_000n)),
		};
	} finally {
		await node.dispose();
	}
}

/** 7. no entry is replayed by `loadState` or by a persistence reload. */
async function reload() {
	const source = await createNode(
		nodeOptions({consoleLog: consoleLog({onLog: () => {}})}),
	);
	const c = client(source);
	const {address} = await c.deploy();
	await c.send(address, c.data.work(1n));
	const dump = await source.dumpState();
	await source.dispose();

	const loadedSunk: string[] = [];
	const loaded = await createNode(
		nodeOptions({
			consoleLog: consoleLog({onLog: (e) => loadedSunk.push(e.message)}),
		}),
	);
	const loadedGot: string[] = [];
	loaded.onConsoleLog((e) => loadedGot.push(e.message));
	await loaded.loadState(dump);
	const loadedBlock = await loaded.request({
		method: 'eth_blockNumber',
		params: [],
	});
	await loaded.dispose();

	const reloadedSunk: string[] = [];
	const reloaded = await createNode(
		nodeOptions({
			persistence: createMemoryPersistence(dump),
			consoleLog: consoleLog({onLog: (e) => reloadedSunk.push(e.message)}),
		}),
	);
	const reloadedBlock = await reloaded.request({
		method: 'eth_blockNumber',
		params: [],
	});
	await reloaded.dispose();
	return {
		dumpBlocks: dump.blocks.length,
		loadedBlock,
		loadedEntries: loadedSunk.length + loadedGot.length,
		reloadedBlock,
		reloadedEntries: reloadedSunk.length,
	};
}

/** 8. `onConsoleLog` on a worker-hosted node. */
async function worker(workerUrl: string) {
	const node = await createWorkerNode({
		worker: new Worker(workerUrl, {type: 'module'}),
		chainId: CHAIN_ID,
	});
	try {
		let threw: string = 'DID NOT THROW';
		let returned: unknown;
		try {
			returned = node.onConsoleLog(() => {});
		} catch (e) {
			threw = String((e as Error)?.message ?? e);
		}
		return {threw, returnedSomething: returned !== undefined};
	} finally {
		await node.dispose();
	}
}

export interface ConsoleLogNodeParams {
	workerUrl: string;
}

export async function runConsoleLogNodeChecks(params: ConsoleLogNodeParams) {
	return {
		automine: await automine(),
		manual: await manual(),
		interval: await interval(),
		sinks: await sinks(),
		identity: await identity(),
		failures: await failures(),
		without: await without(),
		lyingEngine: await lyingEngine(),
		reload: await reload(),
		worker: await worker(params.workerUrl),
	};
}
