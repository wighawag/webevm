/**
 * measure-state-history-cost.mjs: what `stateHistory: {blocks: N}` costs, so the
 * README can state it measured rather than guessed.
 *
 *   pnpm install   # also builds packages/webevm/dist, which this reads
 *   node --expose-gc --max-old-space-size=4096 docs/spikes/bounded-state-history-cost/measure-state-history-cost.mjs
 *
 * RUN IT ALONE, with the heap cap: the largest row holds 256 blocks of 1,000
 * changed slots each. About 30 seconds end to end. It exits non-zero if any of
 * its own checks fails. Spike code: nothing under `packages/` imports it. The
 * results it printed are ./results.md.
 *
 * THE WORKLOAD is a game's: one transaction per block, from one player, to a
 * contract that writes M storage slots per block, in two layouts:
 *
 *   - `same`: the SAME M slots get a new value every block (a board of M cells,
 *     every cell moving every block). Every record holds an OVERWRITTEN value.
 *   - `fresh`: every block writes M slots nobody wrote before. Every record holds
 *     "absent", and no key repeats across blocks.
 *
 * So each block changes M slots plus the accounts the transaction touches,
 * counted from the node's own record of the block (the test-only
 * `changeSetsForTests` probe) rather than assumed.
 *
 * THREE WINDOWS:
 *
 *  1. MEMORY. Each configuration runs in a FRESH child process (so a previous
 *     row's garbage cannot land in this row's heap delta): the same chain of
 *     N + 16 blocks (so the window is full and older records were evicted) with
 *     history off, with a window of 64 and with a window of N = 256. Bytes per
 *     key per retained block is the heap difference between the two windows over
 *     the extra records' keys (one-off allocations cancel); the total is the
 *     N = 256 node minus the node without history. The same records' share of
 *     `dumpState` (the `history` field, what IndexedDB persistence stores) is
 *     reported per key too.
 *  2. PER-BLOCK TIME. The node time of each block (send + mine, auto-mining),
 *     with and without history, over the same chain.
 *  3. HISTORICAL READS. On a node with N = 256, the time of an `eth_call` (the
 *     contract returning one of its slots) and of an `eth_getStorageAt` at
 *     K = head - d for several d, each first checked to return K's value. A
 *     historical `eth_call` builds the union of every record in K+1..head and
 *     applies each DISTINCT key as a state entry before it runs (ADR 0013,
 *     `historicalEntries` in `src/node.ts`); a point read looks its one key up
 *     in those records, from K+1 towards the head, stopping at the first hit.
 *
 * READ THE SHAPES AND THE ORDERS OF MAGNITUDE, NOT THE LAST DIGIT. This is Node on
 * a developer machine, not the browser the library ships to, and heap deltas
 * carry a few percent of GC noise; every ratio is between rows of the same run.
 */
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

if (typeof globalThis.gc !== 'function') {
	console.error('run with node --expose-gc (see the header)');
	process.exit(2);
}

const PKG = new URL('../../../packages/webevm/', import.meta.url);
const require = createRequire(new URL('package.json', PKG));
const {createNode, changeSetsForTests} = await import(
	new URL('dist/node.js', PKG).href
);
const {privateKeyToAccount} = await import(require.resolve('viem/accounts'));

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const CHAIN_ID = 31337;
const GAME = '0x000000000000000000000000000000000000ca5e';
/**
 * With 96 bytes of calldata `(base, count, value)`: stores `value` in slots
 * base+1 .. base+count and stops. With 32 bytes `(slot)`: returns that slot.
 *
 *   36 60 20 14 60 25 57          CALLDATASIZE 0x20 EQ, jump to the reader
 *   5f 35 60 20 35 60 40 35       base, count, value
 *   5b 81 15 60 23 57             loop: count == 0 ? jump to end
 *   80 83 83 01 55                SSTORE(base + count, value)
 *   90 60 01 90 03 90 60 0f 56    count -= 1, jump to loop
 *   5b 00                         end: STOP
 *   5b 5f 35 54 5f 52 60 20 5f f3 reader: return SLOAD(calldata[0])
 */
const GAME_CODE =
	'0x3660201460' +
	'2557' +
	'5f35602035604035' +
	'5b8115602357' +
	'8083830155' +
	'906001900390600f56' +
	'5b00' +
	'5b5f35545f5260205ff3';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const now = () => performance.now();
const failures = [];
function check(ok, what) {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}
function table(headers, rows) {
	console.log(`| ${headers.join(' | ')} |`);
	console.log(`| ${headers.map(() => '---').join(' | ')} |`);
	for (const r of rows) console.log(`| ${r.join(' | ')} |`);
	console.log();
}
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}
function heap() {
	for (let i = 0; i < 4; i++) globalThis.gc();
	return process.memoryUsage().heapUsed;
}

async function newNode(history) {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 30n},
		initialState: {[GAME]: {code: GAME_CODE}},
		...(history ? {stateHistory: {blocks: history}} : {}),
	});
}

/**
 * Pre-sign `blocks` transactions. `'same'`: each rewrites slots 1..M with a new
 * value (a board whose cells all move). `'fresh'`: transaction i writes M slots
 * nobody wrote before (i * M + 1 .. i * M + M), so no key repeats across blocks.
 */
async function signChain(blocks, m, layout) {
	const raws = [];
	for (let i = 0; i < blocks; i++)
		raws.push(
			await account.signTransaction({
				chainId: CHAIN_ID,
				type: 'legacy',
				nonce: i,
				to: GAME,
				gas: BigInt(60_000 + m * 23_000),
				gasPrice: 10n ** 10n,
				data:
					'0x' + word(layout === 'same' ? 0 : i * m) + word(m) + word(i + 1),
			}),
		);
	return raws;
}

/** Run the chain on `node`; returns node milliseconds per block. */
async function runChain(node, raws) {
	const perBlock = [];
	for (const raw of raws) {
		const t0 = now();
		const r = await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		});
		perBlock.push(now() - t0);
		if (r.status !== '0x1') throw new Error(`transaction failed: ${r.status}`);
	}
	return perBlock;
}

/** Keys in a change set: accounts + code entries + storage slots. */
function keysOf(cs) {
	let slots = 0;
	for (const s of cs.storage.values()) slots += s.size;
	return {accounts: cs.accounts.size, code: cs.code.size, slots};
}

function printEnvironment() {
	console.log(
		`Node ${process.version}, ${process.platform} ${process.arch}, ${os.cpus()[0]?.model}`,
	);
	console.log();
}

// ------------------------------------------------------------------------
const N = 256;
const SMALL_N = 64;
const EXTRA = 16;
const BLOCKS = N + EXTRA;

/**
 * THE MEMORY CHILD: one node, one chain, in a FRESH process, so nothing a
 * previous row allocated (or freed late) lands in this row's heap delta. Prints
 * one JSON line and exits.
 */
if (process.argv[2] === '--child') {
	const [m, history, layout] = [
		Number(process.argv[3]),
		Number(process.argv[4]),
		process.argv[5],
	];
	const raws = await signChain(BLOCKS, m, layout);
	const before = heap();
	const node = await newNode(history || undefined);
	const times = await runChain(node, raws);
	const after = heap();
	const probe = changeSetsForTests(node);
	const out = {
		heap: after - before,
		msPerBlock: median(times.slice(EXTRA)),
		sealed: probe.sealedBlocks.length,
		keys: probe.headBlock && keysOf(probe.headBlock),
	};
	if (history) {
		const dump = await node.dumpState();
		out.dumpHistoryBytes = JSON.stringify(dump.history).length;
		out.dumpRecords = dump.history.length;
	}
	console.log(JSON.stringify(out));
	process.exit(0);
}

function child(m, history, layout) {
	const r = spawnSync(
		process.execPath,
		[
			'--expose-gc',
			'--max-old-space-size=4096',
			fileURLToPath(import.meta.url),
			'--child',
			String(m),
			String(history),
			layout,
		],
		{encoding: 'utf8', timeout: 600_000},
	);
	if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
	return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

printEnvironment();

console.log(
	`## 1 and 2. Memory and per-block time: ${BLOCKS} blocks mined, windows of 0 (off), ${SMALL_N} and ${N}\n`,
);
console.log(
	'Each row is three fresh processes. bytes / key is the heap difference between the N = ' +
		`${N} and N = ${SMALL_N} nodes over the ${N - SMALL_N} extra retained blocks' keys ` +
		'(so one-off allocations cancel), and the total is the N = ' +
		`${N} node minus the node without history.\n`,
);
const memoryRows = [];
const timeRows = [];
const bytesPerKey = [];
for (const [m, layout] of [
	[1, 'same'],
	[10, 'same'],
	[100, 'same'],
	[1000, 'same'],
	[100, 'fresh'],
]) {
	const off = child(m, 0, layout);
	const small = child(m, SMALL_N, layout);
	const full = child(m, N, layout);
	const keysPerBlock = full.keys.accounts + full.keys.code + full.keys.slots;
	check(full.sealed === N, `M=${m} ${layout}: exactly N records retained`);
	check(off.sealed === 0, `M=${m} ${layout}: none without history`);
	check(
		full.keys.slots === m,
		`M=${m} ${layout}: each block records ${m} slots`,
	);
	check(
		full.dumpRecords === N,
		`M=${m} ${layout}: the dump carries the ${N} records`,
	);
	const perKey = (full.heap - small.heap) / ((N - SMALL_N) * keysPerBlock);
	bytesPerKey.push(perKey);
	memoryRows.push([
		`${m} (${layout})`,
		`${full.keys.accounts} + ${full.keys.slots}`,
		(off.heap / 1e6).toFixed(2),
		(small.heap / 1e6).toFixed(2),
		(full.heap / 1e6).toFixed(2),
		((full.heap - off.heap) / 1e6).toFixed(2),
		perKey.toFixed(0),
		(full.dumpHistoryBytes / (N * keysPerBlock)).toFixed(0),
	]);
	timeRows.push([
		`${m} (${layout})`,
		off.msPerBlock.toFixed(2),
		full.msPerBlock.toFixed(2),
	]);
}
table(
	[
		'M slots / block',
		'keys / block (accounts + slots)',
		'heap, off (MB)',
		`heap, N=${SMALL_N} (MB)`,
		`heap, N=${N} (MB)`,
		`history at N=${N} (MB)`,
		'bytes / key / block in memory',
		'bytes / key / block in dumpState',
	],
	memoryRows,
);
table(
	['M slots / block', 'ms / block, no history', `ms / block, N=${N}`],
	timeRows,
);

console.log('## 3. Historical reads at K = head - d (median of 21, ms)\n');
const REPS = 21;
const readRows = [];
const callCost = new Map();
for (const [m, layout] of [
	[1, 'same'],
	[10, 'same'],
	[100, 'same'],
	[1000, 'same'],
	[100, 'fresh'],
]) {
	const node = await newNode(N);
	await runChain(node, await signChain(BLOCKS, m, layout));
	const keysPerBlock = m + keysOf(changeSetsForTests(node).headBlock).accounts;
	const head = Number(
		BigInt(await node.request({method: 'eth_blockNumber', params: []})),
	);
	const at = (d) => hex(head - d);
	// Block K wrote the value K into slot base(K) + 1 (base(K) is 0 for 'same',
	// (K - 1) * M for 'fresh'), so reading that slot at K must give K. Checked at
	// every d before any timing, on both read paths.
	const slotAt = (d) =>
		'0x' + word(layout === 'same' ? 1 : (head - d - 1) * m + 1);
	for (const d of [0, 1, 16, 64, 256]) {
		const got = await node.request({
			method: 'eth_call',
			params: [{to: GAME, data: slotAt(d)}, at(d)],
		});
		const point = await node.request({
			method: 'eth_getStorageAt',
			params: [GAME, slotAt(d), at(d)],
		});
		check(
			BigInt(got) === BigInt(head - d) && BigInt(point) === BigInt(head - d),
			`M=${m} ${layout} d=${d}: eth_call and eth_getStorageAt read block ${head - d}'s value`,
		);
	}
	for (const d of [0, 1, 16, 64, 256]) {
		const call = [];
		const point = [];
		for (let r = 0; r < REPS; r++) {
			let t0 = now();
			await node.request({
				method: 'eth_call',
				params: [{to: GAME, data: slotAt(d)}, at(d)],
			});
			call.push(now() - t0);
			t0 = now();
			await node.request({
				method: 'eth_getStorageAt',
				params: [GAME, slotAt(d), at(d)],
			});
			point.push(now() - t0);
		}
		callCost.set(`${m}:${layout}:${d}`, median(call));
		const distinct =
			d === 0
				? 0
				: layout === 'same'
					? keysPerBlock
					: d * m + (keysPerBlock - m);
		readRows.push([
			`${m} (${layout})`,
			d,
			d * keysPerBlock,
			distinct,
			median(call).toFixed(3),
			median(point).toFixed(3),
		]);
	}
	await node.dispose();
}
table(
	[
		'M slots / block',
		'd (blocks below head)',
		'keys recorded since K',
		'distinct keys since K',
		'eth_call at K',
		'eth_getStorageAt at K',
	],
	readRows,
);

// The claims the README makes, checked against this run.
// Rows 1..3 are 'same' at M = 10, 100, 1000: each key overwrites a value.
const overwrite = bytesPerKey.slice(1, 4);
check(
	Math.max(...overwrite) / Math.min(...overwrite) < 1.5,
	'bytes per overwritten key per block is roughly constant from M=10 to M=1000 (memory is linear in keys)',
);
check(
	bytesPerKey[4] < bytesPerKey[3],
	'a key that did not exist before the block (recorded as absent) costs less than an overwrite',
);
const us = (x) => (x * 1000).toFixed(2) + ' us';
const perRecord =
	(callCost.get('1000:same:256') - callCost.get('1000:same:1')) / (255 * 1003);
const perDistinct =
	(callCost.get('100:fresh:256') - callCost.get('100:fresh:0')) / (256 * 100);
console.log(
	`historical eth_call: about ${us(perDistinct)} per DISTINCT key changed since K (applied), about ${us(perRecord)} per further record of a key already applied (scanned)`,
);
check(
	callCost.get('100:fresh:256') > 10 * callCost.get('100:fresh:0'),
	'eth_call cost grows with the distinct keys changed since K',
);

if (failures.length) {
	console.log(`\n${failures.length} check(s) FAILED`);
	process.exit(1);
}
console.log('\nall checks passed');
