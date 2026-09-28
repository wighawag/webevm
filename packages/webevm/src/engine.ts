/**
 * engine.ts — the node-side half of the engine seam: the DEFAULT engine
 * (`@ethereumjs/evm` via `runCall` for reads, `@ethereumjs/vm`'s `runTx` for
 * transactions), plus {@link connectEngine}, the one place an engine is brought
 * up.
 *
 * This is the engine the node uses when the consumer supplies none, and it is
 * exactly what the node's pure-read helper and its mining loop used to do inline.
 * Everything `@ethereumjs/vm` needs in order to make a call READ-ONLY lives HERE
 * rather than in the node above the seam — the checkpoint/revert and the EIP-2929
 * warm/access reset are both requirements of this EVM, not of "a read". An engine
 * that is structurally incapable of committing (revm's `call`) needs neither, and
 * the checkpoint is not free: `SimpleStateManager.checkpointSync()` copies all
 * three state maps and clones every account (0.384 ms per call at 2002 accounts,
 * larger than the whole revm read it would be wrapping). See
 * `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`.
 *
 * The same rule decides where the TRANSACTION half's ethereumjs-specific settings
 * live: inside this module, at `transact` below. For the one of them that turned
 * out to buy a BEHAVIOUR the other engine could not reproduce
 * (`skipBlockGasLimitValidation`), the same rule decided that the behaviour had to
 * go rather than the seam bend around it.
 */
import {runTx, type VM} from '@ethereumjs/vm';
import type {StateManagerInterface} from '@ethereumjs/common';
import type {Address} from '@ethereumjs/util';
import type {TypedTransaction} from '@ethereumjs/tx';
import type {
	Engine,
	EngineContext,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
} from './types.js';

/** The default engine's stable identifier, as reported by `node.engine.id`. */
export const ETHEREUMJS_ENGINE_ID = '@ethereumjs/evm';

/**
 * Wrap the node's own `@ethereumjs/vm` as an engine, covering BOTH operations.
 * Built by the node (it needs the VM and the node's state manager), so it never
 * needs `connect`.
 */
export function createEthereumjsEngine(deps: {
	vm: VM;
	stateManager: StateManagerInterface;
}): Engine {
	const {vm, stateManager} = deps;
	const evm = vm.evm;
	return {
		id: ETHEREUMJS_ENGINE_ID,
		async call(request: ReadCallRequest): Promise<ReadCallResult> {
			// eth_call / eth_estimateGas must NEVER mutate state. runCall on a CREATE
			// bumps the caller nonce (for address derivation) and writes storage, so we
			// checkpoint the state manager and revert after — reads stay pure.
			//
			// CRITICAL: runCall (unlike runTx) does NOT reset the EVM journal's
			// warm/access (EIP-2929) tracking or the EIP-2200 original-storage cache
			// between calls — only runTx calls journal.cleanup(). Without resetting them
			// here, slot warmth + "original value" leak from one pure call into the next,
			// so the SECOND+ eth_estimateGas for a warm SSTORE comes back ~2000 gas too
			// low (warm/dirty pricing instead of SSTORE_RESET). viem then uses that
			// under-estimate as the tx gas LIMIT and the real tx runs OUT OF GAS. Reset
			// the per-tx EVM state before each call so every estimate is computed from a
			// clean baseline, exactly as a fresh transaction would see it. (cleanJournal
			// + originalStorageCache.clear() reset only the warm/access bookkeeping; they
			// do NOT mutate account state.)
			evm.journal?.cleanJournal?.();
			stateManager.originalStorageCache?.clear?.();
			await stateManager.checkpoint();
			try {
				const res = await evm.runCall({
					caller: request.from,
					to: request.to,
					data: request.data,
					value: request.value,
					gasLimit: request.gasLimit,
					block: request.block as any,
				});
				return {
					returnValue: res.execResult.returnValue,
					executionGasUsed: res.execResult.executionGasUsed,
					error: res.execResult.exceptionError?.error,
				};
			} finally {
				await stateManager.revert();
			}
		},

		async transact(request: TransactionRequest): Promise<TransactionResult> {
			// ONE SKIP FLAG LIVES HERE, and nowhere else. It is `@ethereumjs/vm`'s OWN
			// vocabulary, which is why it lives inside this engine rather than on the
			// neutral request:
			//
			//   skipHardForkValidation  skips re-checking the transaction's own
			//                           hardfork-activation rules; the node builds every
			//                           block on the ONE `Common` it created, so there is
			//                           no second fork for a transaction to be valid
			//                           under. An engine with no equivalent simply does
			//                           not have the check to skip.
			//
			// `skipBlockGasLimitValidation` USED TO LIVE HERE TOO, and it is GONE. It let
			// a transaction whose gas limit exceeded the block's be mined against a
			// limit the block did not have, and ONLY on this engine: `revm-wasm` expresses
			// the same relaxation as a simulation switch (`disableBlockGasLimit`) and
			// REFUSES to combine any simulation switch with committing, so the same
			// transaction came back rejected there (`CallerGasLimitMoreThanBlock`). Same
			// node, same transaction, two answers by engine, which is precisely the
			// failure the seam exists to remove, and it is also why this was never made a
			// neutral request field: a field one engine could only throw on is not a
			// neutral request field, it is a promise the next engine cannot keep.
			//
			// SO THE RELAXATION IS BOUGHT BY CONFIGURATION INSTEAD. Both engines now
			// enforce the block's gas limit, and a consumer who wants enormous gas limits
			// raises `blockGasLimit` (`NodeOptions`, default 30,000,000), which both
			// engines honour by construction because they are handed the same block. The
			// node refuses an over-limit transaction ITSELF, at submit, so the refusal can
			// name the numbers and the knob (see `refuseIfOverBlockGasLimit` in ./node.ts).
			// `runTx`'s own "tx has a higher gas limit than the block" is the backstop
			// under it, enforcing the same rule in this EVM's own words.
			//
			// NOTE that the conformance battery's reference `runTx` passes BOTH flags
			// still, so neither dropping one here nor restoring it would show up as a
			// receipt diff. The battery asserts the NODE's answer per engine instead
			// (`block gas limit refuses an over-limit tx; blockGasLimit lifts it`).
			const res = await runTx(vm, {
				// THE SEAM'S SENDER, PINNED FOR `runTx`. See {@link asSender}: this engine
				// executes on behalf of `request.sender` and derives nothing.
				tx: asSender(request.tx, request.sender),
				block: request.block,
				skipHardForkValidation: true,
			});
			return {
				status: (res.receipt as any).status === 0 ? 0 : 1,
				// `totalGasSpent` is NET of refunds (`gasRefund` is already subtracted),
				// which is what a receipt reports and what the sender paid for.
				gasUsed: res.totalGasSpent,
				// The base fee of the block this transaction is IN, which is the node's
				// own (it builds every block with one). `?? 0n` covers a pre-London header,
				// where there is no base fee to add and a legacy transaction's price is its
				// `gasPrice` regardless.
				effectiveGasPrice: effectiveGasPrice(
					request.tx,
					request.block.header.baseFeePerGas ?? 0n,
				),
				logs: (res.execResult.logs ?? []).map(([address, topics, data]) => ({
					address,
					topics,
					data,
				})),
				logsBloom: res.bloom.bitvector,
				createdAddress: res.createdAddress?.bytes,
			};
		},
	};
}

/**
 * `tx` AS SEEN BY `runTx` WHEN IT ASKS WHO SENT IT: the seam's sender, and nothing
 * else changed.
 *
 * WHY THIS EXISTS. The sender crosses the seam as a VALUE
 * (`TransactionRequest.sender`) because it is only sometimes recoverable from the
 * transaction: `senderMode:'trusted'` states it instead, and it may then differ
 * from what the signature recovers to (ADR 0002). But `runTx` has no `sender`
 * option — it reads the sender through exactly one call, `tx.getSenderAddress()`,
 * and uses the result as `caller` for the whole transaction. So SOMETHING has to
 * bridge the value onto that one call, and the right place is here: this is
 * `@ethereumjs/vm`'s own vocabulary, exactly like the two `skip*Validation` flags
 * above, and an engine with a real sender parameter (revm) needs none of it.
 *
 * WHY A VIEW RATHER THAN A PINNED INSTANCE. The node used to shadow
 * `getSenderAddress()` on the transaction it parsed, which made the pin visible to
 * everything downstream and made the guarantee a convention every engine had to
 * know about. `Object.create` leaves the node's transaction untouched and frozen:
 * the pin lives for exactly one `runTx` call, and nothing outside this function can
 * read a fabricated sender back off the transaction. The prototype carries every
 * field and method `runTx` reads (`type`, `nonce`, `to`, `value`, `data`,
 * `gasLimit`, the fee fields, `supports`, `getIntrinsicGas`, `getUpfrontCost`,
 * `hash`), so the only thing this changes is the answer to the sender question.
 *
 * It is applied UNCONDITIONALLY — never "only when it differs" — because comparing
 * would mean calling `tx.getSenderAddress()`, i.e. paying the ~1.6 ms ecrecover
 * that `senderMode:'trusted'` exists to skip.
 */
function asSender(tx: TypedTransaction, sender: Address): TypedTransaction {
	return Object.create(tx, {
		getSenderAddress: {value: () => sender},
	}) as TypedTransaction;
}

/**
 * Legacy-safe effective gas price: what THIS engine charged the sender per gas.
 *
 * It lives behind the seam because the engine that executed the transaction is the
 * engine that charged it, so the fee arithmetic has one implementation per engine
 * and none in the node — an engine reporting a price it did not charge is a bug in
 * that engine, not a disagreement between the node and itself.
 *
 * Type-0 (legacy) txs have no `maxFeePerGas`, so reading it unconditionally throws
 * ("Cannot mix BigInt and other types"). Branch on the field so legacy receipts
 * compute their `effectiveGasPrice` correctly.
 */
function effectiveGasPrice(tx: TypedTransaction, blockBaseFee: bigint): bigint {
	const anyTx = tx as any;
	if (anyTx.maxFeePerGas !== undefined && anyTx.maxFeePerGas !== null) {
		const maxFee: bigint = anyTx.maxFeePerGas;
		const maxPrio: bigint = anyTx.maxPriorityFeePerGas ?? 0n;
		const tip =
			maxFee - blockBaseFee < maxPrio ? maxFee - blockBaseFee : maxPrio;
		return tip + blockBaseFee;
	}
	return anyTx.gasPrice as bigint;
}

/**
 * Bring an engine up for this node, or FAIL THE WHOLE CONSTRUCTION.
 *
 * THE POINT OF THIS FUNCTION IS THE ABSENCE OF A FALLBACK. Every other outcome
 * here is a silent lie: a consumer who passed a revm engine and was quietly
 * given `@ethereumjs/evm` instead would get a node that comes up, answers every
 * call correctly, and runs an order of magnitude slower than they believe. They
 * would measure it, be confused, and have no signal to follow. So there is no
 * `catch` that continues, no default substituted on failure, and no partially
 * connected engine: if the engine cannot serve this node, `createNode()` throws
 * (honest edge — see `docs/adr/0004-no-account-or-signing-methods.md` for the
 * same convention on the RPC surface).
 *
 * Three ways an injected engine fails, all landing here at construction rather
 * than at the first opcode:
 *  1. it is not an `Engine` at all (a stray object, a module namespace, a
 *     forgotten `await` on `createRevmEngine()`) — otherwise the node comes up
 *     and dies at the first `eth_call` with a `not a function` TypeError that
 *     reads like a node bug;
 *  2. it implements only HALF the seam: no usable `transact`. There is no second
 *     engine to mine on, so this is a missing capability the node cannot supply;
 *  3. its `connect(context)` throws, either because it cannot initialise (no
 *     wasm, no memory) or because it refuses this node's configuration (the
 *     revm engine refuses a hardfork it cannot cost, ADR 0008).
 *
 * The engine's own message is preserved verbatim inside the thrown error's
 * message (not only as `cause`), because the engine is the only party that
 * knows WHY, and browser consoles routinely show a message without its cause.
 */
export async function connectEngine(
	engine: Engine,
	context: EngineContext,
): Promise<void> {
	if (typeof engine?.call !== 'function' || typeof engine?.id !== 'string') {
		throw new Error(
			`webevm: the value passed as \`engine\` is not an Engine — it must have a string \`id\` and a \`call(request)\` method (got ${describe(engine)}). ` +
				`The node does NOT fall back to the default @ethereumjs/evm engine, because a node running an engine you did not ask for is indistinguishable from one that works. ` +
				`If you built it with an async factory (e.g. \`createRevmEngine()\`), await it first.`,
		);
	}
	// `transact` IS REQUIRED, and this is the guard that says so at construction.
	// It was briefly optional — for exactly as long as the shipped revm engine had
	// no write half — and an engine that omitted it had its transactions mined on
	// the node's own `@ethereumjs/vm`. That fallback is GONE: a node must run ONE
	// EVM, so `node.engine` names the engine that answered its reads AND executed
	// its transactions, and a receipt can be attributed to it.
	//
	// MISSING and BROKEN are refused together, in the same words, because they are
	// the same mistake from the node's point of view (a half-built engine) and
	// neither can be served: there is no second engine to fall back to, and one
	// substituted silently is the lie `connectEngine` exists to refuse.
	if (typeof (engine as Engine).transact !== 'function') {
		throw new Error(
			`webevm: the engine '${engine.id}' has no usable \`transact\` method (got ${typeof engine.transact}). ` +
				`An Engine implements BOTH operations — \`call\` for reads and \`transact\` to execute and commit a signed transaction — because the node executes its transactions on the engine you passed. ` +
				`It is deliberately NOT filled in with the default @ethereumjs/evm engine: a node running one EVM for reads and another for transactions has two chances to disagree with itself, and a receipt from it cannot be attributed to the engine ${'`node.engine`'} names.`,
		);
	}
	try {
		await engine.connect?.(context);
	} catch (err) {
		throw new Error(
			`webevm: the engine '${engine.id}' could not be connected, so the node was NOT created. ` +
				`It is deliberately NOT replaced by the default @ethereumjs/evm engine: that node would work, return correct results, and run at a completely different speed from the one you asked for, silently. ` +
				`Fix the engine's configuration or pass a different engine. Cause: ${message(err)}`,
			{cause: err},
		);
	}
}

/** A short, safe rendering of whatever was passed as an engine. */
function describe(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value !== 'object') return typeof value;
	if (typeof (value as Engine).id === 'string') {
		return `an object with id '${(value as Engine).id}' and no call()`;
	}
	return `an object with keys [${Object.keys(value as object).join(', ')}]`;
}

function message(err: unknown): string {
	return String((err as Error)?.message ?? err);
}
