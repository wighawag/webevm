/**
 * console-log-checks.ts: Solidity `console.log` THROUGH THE DEV NODE. The dev
 * node does not override `onConsoleLog` (ADR 0017: every member the layer does
 * not override delegates), so these checks prove the pass-through, not the
 * logging itself (webevm's own console-log-node suite covers that):
 *   1. `createDevNode({consoleLog})` passes the option to the node it creates:
 *      a subscriber on the dev node receives the entries of a dev account's
 *      `eth_sendTransaction` (a deploy and a call, with their hash, block and
 *      index) and of an `eth_call`, and the sink receives the same
 *   2. "as on the bare node": on `wrapDevNode(node)`, a subscriber on the dev
 *      node and one on the node it wraps receive the SAME entry objects
 *   3. on a node without console logging, the dev node's `onConsoleLog` throws
 *      the node's own error (the very object, and the core's message)
 *   4. unsubscribing through the dev node stops delivery
 * The fixture is the precompiled `ConsoleLogProbe` (./console-log-probe.ts, a
 * copy of webevm's). Run in a real browser page by ./cut.ts.
 *
 * It RETURNS what it observed (bigints as `<n>n` strings) and asserts nothing
 * itself: ../console-log.spec.ts holds the assertions.
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {encodeFunctionData, type Hex} from 'viem';
import {createNode, type SlimNode} from 'webevm';
import {consoleLog, type ConsoleLogEntry} from 'webevm/console-log';
import {
	createDevNode,
	devAccountBalances,
	wrapDevNode,
} from '../../src/index.js';
import {
	consoleLogProbeAbi,
	consoleLogProbeBytecode,
} from './console-log-probe.js';

/** An entry as it can cross back to the spec: bigints as `<n>n` strings. */
function plain(e: ConsoleLogEntry): Record<string, unknown> {
	return {
		...e,
		args: e.args.map((a) => (typeof a === 'bigint' ? `${a}n` : a)),
	};
}

const workData = (n: bigint) =>
	encodeFunctionData({
		abi: consoleLogProbeAbi,
		functionName: 'work',
		args: [n],
	});
const peekData = (who: Hex) =>
	encodeFunctionData({
		abi: consoleLogProbeAbi,
		functionName: 'peek',
		args: [who],
	});

/** A dev account's sends and reads, all through the dev node's `request`. */
function client(node: SlimNode, from: Hex) {
	async function send(to: Hex | null, data: Hex) {
		const hash = (await node.request({
			method: 'eth_sendTransaction',
			params: [{from, ...(to ? {to} : {}), data, gas: '0xf4240'}],
		})) as Hex;
		const r = (await node.request({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		})) as {
			status: Hex;
			blockNumber: Hex;
			blockHash: Hex;
			transactionIndex: Hex;
			contractAddress: Hex | null;
		};
		return {
			hash,
			status: r.status,
			blockNumber: Number(BigInt(r.blockNumber)),
			blockHash: r.blockHash,
			txIndex: Number(BigInt(r.transactionIndex)),
			contractAddress: r.contractAddress,
		};
	}
	function call(to: Hex, data: Hex) {
		return node.request({
			method: 'eth_call',
			params: [{from, to, data}, 'latest'],
		}) as Promise<Hex>;
	}
	return {send, call};
}

/** What a synchronous call threw, or `'returned'`. */
function thrown(f: () => unknown): unknown {
	try {
		f();
		return 'returned';
	} catch (e) {
		return e;
	}
}

export async function runConsoleLogChecks() {
	// ---- 1. createDevNode passes `consoleLog` to the node it creates ----
	const sunk: ConsoleLogEntry[] = [];
	const devNode = await createDevNode({
		consoleLog: consoleLog({onLog: (e) => sunk.push(e)}),
	});
	const [sender] = (await devNode.request({method: 'eth_accounts'})) as Hex[];
	const received: ConsoleLogEntry[] = [];
	const unsubscribe = devNode.onConsoleLog((e) => received.push(e));
	const c = client(devNode, sender);
	const taken = () => received.splice(0).map(plain);

	const deploy = await c.send(null, consoleLogProbeBytecode);
	const deployEntries = taken();
	const probe = deploy.contractAddress as Hex;
	const work = await c.send(probe, workData(5n));
	const workEntries = taken();
	const peekResult = await c.call(probe, peekData(sender));
	const peekEntries = taken();
	const sinkCount = sunk.length;

	// ---- 4. unsubscribing through the dev node stops delivery ----
	const kept: ConsoleLogEntry[] = [];
	const unsubscribeKept = devNode.onConsoleLog((e) => kept.push(e));
	unsubscribe();
	const afterUnsub = await c.send(probe, workData(1n));
	await c.call(probe, peekData(sender));
	const unsubscribed = {
		receivedAfter: received.length,
		keptAfter: kept.map(plain),
		afterUnsub,
	};
	unsubscribeKept();
	await devNode.dispose();

	// ---- 2. wrapDevNode: the dev node's entries ARE the bare node's ----
	const inner = await createNode({
		initialBalances: devAccountBalances(),
		consoleLog: consoleLog({onLog: () => {}}),
	});
	const wrapped = wrapDevNode(inner);
	const viaInner: ConsoleLogEntry[] = [];
	const viaWrapped: ConsoleLogEntry[] = [];
	inner.onConsoleLog((e) => viaInner.push(e));
	wrapped.onConsoleLog((e) => viaWrapped.push(e));
	const w = client(wrapped, sender);
	const wDeploy = await w.send(null, consoleLogProbeBytecode);
	await w.send(wDeploy.contractAddress as Hex, workData(2n));
	await w.call(wDeploy.contractAddress as Hex, peekData(sender));
	const wrap = {
		innerCount: viaInner.length,
		wrappedCount: viaWrapped.length,
		sameObjects:
			viaInner.length === viaWrapped.length &&
			viaInner.every((e, i) => e === viaWrapped[i]),
		sources: viaWrapped.map((e) => e.source),
	};
	await wrapped.dispose();

	// ---- 3. no console logging: the node's own error, unchanged ----
	const bare = await createNode({});
	const bareError = thrown(() => bare.onConsoleLog(() => {})) as Error;
	await bare.dispose();
	const silentDev = await createDevNode();
	const devError = thrown(() => silentDev.onConsoleLog(() => {})) as Error;
	await silentDev.dispose();
	// the very object the node threw, through a node that throws its own
	const silentInner = await createNode({});
	const sentinel = new Error('thrown by the wrapped node itself');
	const stub: SlimNode = {
		...silentInner,
		onConsoleLog() {
			throw sentinel;
		},
	};
	const stubError = thrown(() => wrapDevNode(stub).onConsoleLog(() => {}));
	await silentInner.dispose();
	const notEnabled = {
		bareMessage: bareError?.message,
		devMessage: devError?.message,
		devIsError: devError instanceof Error,
		sameAsNode: stubError === sentinel,
	};

	return {
		sender,
		deploy: {...deploy, entries: deployEntries},
		work: {...work, entries: workEntries},
		peek: {result: peekResult, entries: peekEntries},
		sinkCount,
		subscriberCount:
			deployEntries.length + workEntries.length + peekEntries.length,
		unsubscribed,
		wrap,
		notEnabled,
	};
}
