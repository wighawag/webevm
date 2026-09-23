/**
 * types.ts — the public shape of the slim node. Deliberately tiny and
 * transport-agnostic: a node is just an object with an async EIP-1193 `request()`
 * plus a few node-owned controls (`mine`/`dumpState`/`loadState`). It knows
 * NOTHING about Workers — because `request()` is already async, the exact same
 * object works unchanged whether called on the main thread or across a thread
 * boundary (see ../worker.ts for the optional comlink wrapper).
 *
 * The `@ethereumjs/*` imports below are TYPE-ONLY (erased at build time), so this
 * module — and the core entry point that re-exports it — adds no runtime import.
 */
import type {Address} from '@ethereumjs/util';
import type {Block} from '@ethereumjs/block';
import type {TypedTransaction} from '@ethereumjs/tx';
import type {StateManagerInterface} from '@ethereumjs/common';
import type {Common} from '@ethereumjs/common';

/** Minimal EIP-1193 request args. */
export interface RequestArguments {
	readonly method: string;
	readonly params?: readonly unknown[] | object;
}

/** EIP-1193-style JSON-RPC error (what we throw for honest gaps). */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = 'RpcError';
		this.code = code;
		this.data = data;
	}
}

export type MiningConfig =
	| {type: 'auto'} // mine one block per raw tx (pairs with eth_sendRawTransactionSync)
	| {type: 'manual'} // only mine on explicit node.mine()
	| {type: 'interval'; intervalMs: number}; // mine on a timer

export interface PersistenceAdapter {
	/** Load the single serialized state record (or null on first run). */
	load(): Promise<SerializedState | null>;
	/**
	 * Persist the single serialized state record.
	 *
	 * DO NOT CALL BACK INTO THE NODE FROM HERE. A node serves one request at a
	 * time, and this hook is AWAITED inside the request that triggered it — that
	 * is what makes `state` a snapshot of a settled chain rather than one caught
	 * mid-transaction, and what stops a request resolving before its state is
	 * durable. A `node.request(...)` awaited from inside this function therefore
	 * waits for a queue that is waiting for this function, and the node stops.
	 * Everything you could ask it for is already in `state`; if you need the node
	 * itself, do that work after `save()` resolves.
	 *
	 * It is a rule rather than a check because the two cases cannot be told apart:
	 * see `docs/adr/0012-one-request-at-a-time-the-node-serialises-its-whole-public-surface.md`.
	 * Other callers are unaffected — a request issued elsewhere while this hook is
	 * running simply queues behind it.
	 */
	save(state: SerializedState): Promise<void>;
}

/**
 * State backing mode.
 * - `'none'` (DEFAULT): `SimpleStateManager` — plain Maps, NO trie, NO state root.
 *   The fast path; block `stateRoot`/`receiptsRoot`/`transactionsRoot` are zero
 *   placeholders (you are a local chain; canonical roots aren't needed). This is
 *   the recommended mode and what makes the node ~4× faster than the trie path.
 * - `'trie'`: `MerkleStateManager` — real Merkle-Patricia trie. SLOWER (recomputes
 *   the state root each tx) but produces a REAL `stateRoot`, which (a) lets the
 *   node be conformance-tested against `ethereum/tests` GeneralStateTests (they
 *   verify the post-state root), and (b) gives honest canonical block roots for
 *   consumers that need them. Opt-in: pay for the trie only when you want it.
 */
export type StateMode = 'none' | 'trie';

/**
 * Sender-derivation mode.
 * - `'recover'` (DEFAULT): derive the sender from the signature with ecrecover,
 *   exactly as a real node does. The tx is self-authenticating: a caller cannot
 *   claim to be an address it does not hold the key for. This is the only mode
 *   that is safe when the node is reachable by a caller you do not control.
 * - `'trusted'`: TRUST a caller-supplied sender and SKIP ecrecover entirely.
 *   Enables `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, which
 *   take an explicit `from`. The signature is still carried on the wire and the
 *   tx hash is still the real one, but it is NEVER verified, so ANY caller can
 *   claim to be ANY address.
 *
 * Why it exists: ecrecover is a FIXED cost per tx and it dominates small ones. A
 * client that signed the tx already knows the sender, so re-deriving it is pure
 * waste in a local chain. Measured (2026-08-11,
 * `docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md`) at
 * ~6.2x on the isolated transaction path (2.09 -> 0.33 ms/tx, signing outside the
 * window) and ~3.6x end-to-end through a viem-style client, with byte-identical
 * gas and status.
 *
 * HOW BIG THE GAP IS DEPENDS ON THE ENGINE NOW. `'recover'` recovers with the
 * INSTALLED ENGINE's secp256k1 when it has one ({@link Engine.ecrecover}, which
 * `webevm/revm` implements at zero additional bytes — the `0x01`
 * precompile is already in that module), and that makes the expensive half of
 * `'recover'` about 4.3x cheaper: 2.02 -> 0.65 ms/tx isolated, so the gap narrows
 * to ~2.8x (~1.8x end to end). `'trusted'` is still worth having and has stopped
 * being the dominant lever. With no such engine, recovery is `@ethereumjs/tx`'s
 * as before, and so is the ~6.2x.
 *
 * The primitive is just "execute as this sender, do not recover". It serves BOTH
 * an ordinary signed tx that wants to skip a redundant recovery AND a higher
 * layer building anvil-style impersonation on top with a fabricated signature.
 * Impersonation itself is account POLICY and is deliberately NOT this package's
 * job — see the `parseTx` docblock in node.ts for the full caller contract
 * (notably: fabricated txs must be made unique per sender, or their hashes
 * collide).
 *
 * The trade is real and one-directional: `'trusted'` removes the ONLY thing that
 * binds a tx to its sender. Use it for a local, same-origin dev chain or an
 * in-browser game. Never expose a `'trusted'` node over a transport that an
 * untrusted caller can reach.
 */
export type SenderMode = 'recover' | 'trusted';

/**
 * One read-only call for an {@link Engine} to execute: exactly the inputs the
 * node's pure-read helper has always handed `runCall`, and nothing more.
 *
 * The value types are `@ethereumjs/*`'s own (`Address`, `Block`) rather than hex
 * strings, because the node already holds them in that form and the default
 * engine passes them straight through — converting at the seam would add cost and
 * a chance to change behaviour, in a refactor whose whole point is changing none.
 */
export interface ReadCallRequest {
	/** Caller (`msg.sender`). The node defaults it to the zero address. */
	readonly from: Address;
	/** Callee, or `undefined` for a CREATE-shaped call (gas estimation). */
	readonly to?: Address;
	/** Calldata (or init code when `to` is absent). */
	readonly data: Uint8Array;
	readonly value: bigint;
	/** Gas made available to EXECUTION (intrinsic gas is the node's business). */
	readonly gasLimit: bigint;
	/** The block the call observes (NUMBER, TIMESTAMP, COINBASE, BASEFEE...). */
	readonly block: Block;
}

/** What an engine reports back for a read-only call. */
export interface ReadCallResult {
	/**
	 * Return data (or the revert data when {@link error} is set) — the CALLEE's
	 * bytes, and nothing else. `eth_call` surfaces exactly these as the `data` of
	 * its `execution reverted` error, where a client decodes them as a revert
	 * reason, so a failure that ran NO code (a call the engine refused before
	 * execution: an unaffordable value, a gas budget below the intrinsic cost)
	 * reports EMPTY here on every engine and puts its explanation in
	 * {@link error}. An engine whose own diagnostics arrive in this field must
	 * drop them rather than pass them on — `src/revm.ts` does, and
	 * `test/helpers/revm-engine.ts` holds both engines to the same bytes.
	 */
	readonly returnValue: Uint8Array;
	/**
	 * EXECUTION gas only — NOT a transaction's total, and NOT by itself an answer
	 * to `eth_estimateGas`. The node adds the intrinsic gas (21000 base, +32000
	 * create, calldata bytes, EIP-3860 initcode) to it, exactly as it did before
	 * the seam existed, and that sum is what a request CONSUMES. `eth_estimateGas`
	 * uses it as the FLOOR of a search for the smallest gas LIMIT the request
	 * succeeds at, because EIP-150's 63/64 rule makes consumption unusable as a
	 * limit for anything that calls out or creates (see `estimateGas` in
	 * ./node.ts) — so an engine may be asked for the same call several times, at
	 * descending {@link ReadCallRequest.gasLimit}s.
	 *
	 * WHEN A FRAME HALTS FOR WANT OF GAS, THIS IS THE WHOLE BUDGET IT WAS GIVEN,
	 * and that is load-bearing rather than incidental: it is how the node tells
	 * "needs more gas than the allowance" apart from "reverted" without matching on
	 * either engine's words for it.
	 */
	readonly executionGasUsed: bigint;
	/**
	 * Set iff the call did not succeed (a revert, a halt, or a refusal BEFORE
	 * execution); the EVM's own error string, which is where an engine's words for
	 * a failure belong. The two engines differ here by design — `insufficient
	 * balance` against revm's quoted `Transaction(LackOfFundForMaxFee { .. })` —
	 * and `node.ts` flattens both into one `execution reverted`, so nothing above
	 * the seam can tell the engines apart by it.
	 */
	readonly error?: string;
}

/**
 * One SIGNED transaction for an {@link Engine} to execute AND COMMIT, plus the
 * block it is being mined in.
 *
 * NOT an RPC-level transaction request: there is nothing to fill in here and
 * nothing optional. `eth_sendTransaction` does not exist on this node, and
 * `eth_fillTransaction` returns its own object, one layer above the seam.
 *
 * THE TRANSACTION CROSSES AS THE NODE PARSED IT, for the reason
 * {@link ReadCallRequest} carries `Address`/`Block`: the node already holds it in
 * that form and the default engine hands it straight to `runTx`.
 *
 * THE SENDER CROSSES AS A SEPARATE VALUE ({@link sender}) rather than as something
 * an engine reads off {@link tx}, and that is the whole reason this field exists.
 *
 * WHAT IS DELIBERATELY ABSENT: any switch that relaxes this transaction's
 * VALIDITY. The read path's simulation switches (base fee, block gas limit,
 * EIP-3607 — see the `call` side of `src/revm.ts`) have no counterpart here, and
 * `@ethereumjs/vm`'s own `skipHardForkValidation` stays INSIDE the default engine
 * where it means something (see `src/engine.ts`). Its `skipBlockGasLimitValidation`
 * is not here either, and it is no longer there: it relaxed a rule only ONE engine
 * could relax, so the relaxation was dropped rather than relocated, and a consumer
 * who wants gas limits above the block's raises `NodeOptions.blockGasLimit` so that
 * the block really is that large. A transaction that runs with relaxed validity is
 * not a transaction.
 */
export interface TransactionRequest {
	/** The signed transaction, parsed by the node (which owns parsing). */
	readonly tx: TypedTransaction;
	/**
	 * WHO SENT IT, as a VALUE the node states: `msg.sender` of the top-level frame,
	 * the account whose balance and nonce this transaction moves, and the `from` on
	 * the receipt the node builds. AUTHORITATIVE. An engine executes on behalf of
	 * THIS address and must never derive one of its own.
	 *
	 * WHY IT IS A FIELD AND NOT A CALL. Sender derivation is the NODE's (`ADR 0006`)
	 * — an engine may LEND it the curve step ({@link Engine.ecrecover}) but never the
	 * decision, which is the distinction that entry draws —
	 * and in `senderMode:'trusted'` (the `evm_*As` cheats, ADR 0002) the node is TOLD
	 * the sender and deliberately skips ecrecover — so the authoritative sender may
	 * differ from whatever {@link tx}'s signature recovers to, and for a FABRICATED
	 * signature there is no meaningful recoverable sender at all. An engine that
	 * recovers the sender itself does not fail loudly on such a transaction: it
	 * charges a different account, advances a different nonce, and hands back a
	 * receipt that looks completely right. The only way that cannot happen is for the
	 * sender to be DATA on the request, so that an engine which ignores it is
	 * ignoring a stated input rather than merely disagreeing with a convention.
	 *
	 * It is therefore REQUIRED and non-optional: `{tx, block}` with no sender is not
	 * a transaction request, and an engine written against this type cannot be handed
	 * one. What an engine does with it is the engine's: the default `@ethereumjs/evm`
	 * engine pins it onto the `runTx` call (`src/engine.ts` — `runTx` reads the sender
	 * through exactly one method), and `webevm/revm` passes it as revm's
	 * `from`, which takes a sender directly and recovers nothing.
	 *
	 * `sender`, NOT `from`, deliberately — the two words are not synonyms here.
	 * {@link ReadCallRequest.from} is `eth_call`'s own parameter: caller-supplied,
	 * unauthenticated by nature, defaulted to the zero address. A transaction's
	 * `from` is the RPC RENDERING of this value on the receipt. What crosses here is
	 * the SENDER, which is this repo's word for the thing `senderMode` chooses how to
	 * obtain (recover it, or be told it) — so the field name says which concept it is
	 * rather than borrowing the read path's parameter name for something stronger.
	 */
	readonly sender: Address;
	/** The block it is mined in (NUMBER, TIMESTAMP, COINBASE, BASEFEE, GASLIMIT). */
	readonly block: Block;
}

/**
 * One log, as the seam carries it: raw bytes, no `@ethereumjs/*` types, no
 * position. Block/transaction position (`blockNumber`, `logIndex`, ...) is the
 * NODE's — an engine executing one transaction cannot know where in a block it
 * sits.
 */
export interface TransactionLog {
	/** Emitting contract, 20 bytes. */
	readonly address: Uint8Array;
	/** 0-4 topics, 32 bytes each. */
	readonly topics: readonly Uint8Array[];
	readonly data: Uint8Array;
}

/**
 * What an engine reports back for an executed transaction: EVERYTHING A RECEIPT
 * NEEDS FROM AN EVM, and nothing else.
 *
 * THIS TYPE IS THE SEAM'S POINT. It is what makes two EVMs comparable field by
 * field: the default engine fills it from a `runTx` result, another fills it from
 * its own outcome, and the node builds the same receipt either way. So it is
 * designed from the RECEIPT backwards, not from what `@ethereumjs/vm` happens to
 * return — `amountSpent`, `gasRefund`, `minerValue`, `accessList` and the
 * `execResult` are all absent because no receipt reads them.
 *
 * WHAT STAYS THE NODE'S, and is therefore not here: `cumulativeGasUsed` (a
 * block-level accumulation over several transactions), the transaction hash,
 * index, type, `from`/`to`, the block it landed in, and log positions. An engine
 * executes one transaction; it does not build blocks.
 *
 * THE VALUES ARE RAW BYTES AND BIGINTS on purpose. An engine that is not
 * `@ethereumjs/*` (revm-wasm, next) produces bytes, and a seam typed in one
 * engine's classes would make every other engine convert into a vocabulary it
 * does not speak.
 */
export interface TransactionResult {
	/**
	 * `1` succeeded, `0` failed — the receipt's own status, and the only thing a
	 * receipt says about failure. A revert REASON is deliberately absent: a receipt
	 * has no field for it (the read path's {@link ReadCallResult.error} is what
	 * surfaces engine words, to `eth_call`).
	 */
	readonly status: 0 | 1;
	/**
	 * Gas the sender PAYS FOR: NET of refunds, which is what the receipt reports
	 * and what `cumulativeGasUsed` accumulates. Not the gross gas spent before
	 * refunds — an engine reporting both must map the net one here (the read path
	 * wants the gross one, because a read has no refund).
	 */
	readonly gasUsed: bigint;
	/**
	 * Wei per gas actually charged — `min(maxFeePerGas, baseFee + tip)` for a 1559
	 * transaction, `gasPrice` for a legacy one. It comes from the engine that
	 * executed the transaction because that engine is what CHARGED it, so there is
	 * exactly one implementation of the fee arithmetic per engine and none in the
	 * node.
	 */
	readonly effectiveGasPrice: bigint;
	/**
	 * Logs in EMISSION order, and only the ones that SURVIVED: a log emitted inside
	 * a reverted sub-call is not here.
	 */
	readonly logs: readonly TransactionLog[];
	/** The 256-byte bloom over {@link logs} (all zero when there are none). */
	readonly logsBloom: Uint8Array;
	/**
	 * The address a top-level CREATE produced, 20 bytes; absent for a call, and
	 * absent for the nested creations a transaction performs (they are not the
	 * receipt's `contractAddress`).
	 */
	readonly createdAddress?: Uint8Array;
}

/**
 * What the node hands an engine once, at construction, so the engine can reach
 * the node's AUTHORITATIVE state. Deliberately minimal: a later engine that needs
 * more adds a field here rather than the node guessing now (ADR 0006 names this
 * additive widening as the sanctioned way to grow the seam — `getBlockHash`
 * arrived that way, for `webevm/revm`).
 */
export interface EngineContext {
	/** The node's live state manager. The node keeps ownership; do not fork it. */
	readonly stateManager: StateManagerInterface;
	/** Chain params (chain id, hardfork, custom crypto) the node runs under. */
	readonly common: Common;
	/**
	 * The hash of one of the node's blocks, by number, for the `BLOCKHASH` opcode
	 * — `undefined` for a block the node does not have (the EVM then reads zero).
	 *
	 * SYNCHRONOUS, unlike everything else the node does with blocks, because
	 * `BLOCKHASH` is answered in the middle of an opcode and a wasm interpreter has
	 * no suspension point to await at. It is a live lookup, not a snapshot: the
	 * node has mined no blocks yet when `connect` runs.
	 *
	 * An engine that leaves this unwired makes `BLOCKHASH` answer nothing for
	 * blocks the node actually has, silently — which is why it is on the context
	 * rather than an engine-side option to remember to pass.
	 */
	getBlockHash(blockNumber: bigint): Uint8Array | undefined;
	/**
	 * The node's state mode. An engine that cannot serve it must THROW here —
	 * `connect` is called during `createNode()`, so the refusal lands at
	 * construction rather than at the first opcode.
	 */
	readonly stateMode: StateMode;
}

/**
 * THE EVM BEHIND THE NODE, in ONE interface with TWO REQUIRED operations: execute
 * a read-only {@link call} (`eth_call`, `eth_estimateGas`, `eth_fillTransaction`'s
 * estimation) and execute a committing {@link transact} (the mining path).
 *
 * ONE INTERFACE, NOT TWO, and neither operation is a capability an engine may
 * decline. What differs between them is a transaction's VALIDITY rules, not their
 * engine-ness: a read RELAXES them (base fee, block gas limit, EIP-3607) and
 * cannot commit, a transaction relaxes nothing and commits. That asymmetry belongs
 * to the operations, and stating it in one place where both are visible beats
 * splitting it across two interfaces that could be pointed at two different EVMs
 * (two identifiers that can disagree, for no gain).
 *
 * An engine is an INJECTED OBJECT, never a name the core resolves — see
 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.
 *
 * A read-only call MUST NOT mutate the node's state. Whatever it takes to hold
 * that (a checkpoint/revert, a warm-slot reset, or nothing at all) is the
 * ENGINE's business, not the node's: the default `@ethereumjs/evm` engine needs
 * both and pays for both, an engine that is structurally incapable of committing
 * pays for neither.
 */
export interface Engine {
	/**
	 * Stable identifier for bug reports (`'@ethereumjs/evm'` for the default).
	 * Surfaced verbatim as `node.engine.id`.
	 */
	readonly id: string;
	/**
	 * Bind to the node's state + chain context. Called EXACTLY once, during
	 * `createNode()`, before any call. Optional: an engine the node itself builds
	 * already has what it needs. Throwing here fails node construction.
	 */
	connect?(context: EngineContext): void | Promise<void>;
	/** Execute one read-only call against the node's CURRENT state. */
	call(request: ReadCallRequest): Promise<ReadCallResult>;
	/**
	 * Execute one signed transaction against the node's state AND COMMIT it,
	 * reporting what a receipt needs. Full validity: nonce checked, fees charged,
	 * no simulation switch anywhere near it.
	 *
	 * REQUIRED, like {@link call}, and refused at construction if it is missing or
	 * is not callable (`connectEngine` in `src/engine.ts`). The node does not fill
	 * it in with its own `@ethereumjs/vm`: a node running one EVM for reads and
	 * another for transactions has two chances to disagree with itself, and a
	 * receipt from it could not be attributed to the engine `node.engine` names.
	 *
	 * NONCE CHECKING IS THE CALL PATH'S CHOICE, NOT A PARAMETER. It is ON here
	 * because this method is the transaction path, and OFF for {@link call} because
	 * that is `eth_call` semantics. Nothing on {@link TransactionRequest} can turn
	 * it off, and nothing should be added that can: a transaction executed without
	 * the check is silently replayable, so the property worth having is that
	 * forgetting it is impossible rather than merely discouraged.
	 *
	 * THROW to reject a transaction the chain would not accept (a replayed nonce, an
	 * unaffordable fee). The node's mining path is written against that shape —
	 * `@ethereumjs/vm`'s `runTx` throws — so an engine reporting an invalid
	 * transaction as a zero-gas result would have the node mine a block containing a
	 * receipt for a transaction that never ran.
	 */
	transact(request: TransactionRequest): Promise<TransactionResult>;
	/**
	 * secp256k1 PUBLIC-KEY RECOVERY, offered as a PRIMITIVE: recover the 20-byte
	 * address that produced `(r, s)` over `hash` with `recoveryId`, or `undefined`
	 * when it recovers to nothing. Synchronous, stateless, and callable BEFORE
	 * {@link connect} — it touches no state, no block and no hardfork.
	 *
	 * OPTIONAL, and the ONLY optional operation on this interface. {@link call} and
	 * {@link transact} are capabilities the node cannot supply for an engine that
	 * omits them, so they are refused at construction; this one the node can, and
	 * always could — with no engine ecrecover it recovers the sender through
	 * `@ethereumjs/tx` as it always did. An engine implements it when its module
	 * ALREADY carries secp256k1 (`webevm/revm` does: the `0x01`
	 * precompile's own k256, reached without a database or a journal), which is why
	 * it costs zero additional bytes to offer and why offering it is not a
	 * requirement anyone should be held to.
	 *
	 * IT IS NOT "SENDER DERIVATION", and the distinction is the whole reason this
	 * is shaped as `(hash, recoveryId, r, s)` rather than as a transaction. Deciding
	 * WHO SENT A TRANSACTION stays the node's, on every engine (see
	 * {@link TransactionRequest.sender}): the node computes the message hash,
	 * enforces EIP-2's low-`s` rule, turns the wire's `v` — 27/28, `chainId * 2 +
	 * 35/36`, or a bare y-parity — into a 0/1 recovery id, and only THEN asks the
	 * curve. An engine is handed a question about a signature and never one about a
	 * transaction, so it needs to know nothing about EIP-155, EIP-2718 or
	 * `senderMode`, and it can neither admit a transaction the node would refuse nor
	 * refuse one the node would admit.
	 *
	 * EIP-2 IN PARTICULAR IS NOT YOURS TO ENFORCE. revm's implementation of this is
	 * the `0x01` precompile's, which NORMALISES a high-`s` signature and returns an
	 * address — correctly, because EIP-2 constrains transactions, not the
	 * precompile. The node refuses such a transaction above the seam so that the
	 * answer is the same on every engine. Implement this as the raw curve operation
	 * and add no protocol opinions to it.
	 *
	 * RETURN `undefined` rather than throwing when the signature does not recover:
	 * the node turns that into its own refusal, in the same shape on every engine.
	 *
	 * @param hash 32-byte message digest that was signed.
	 * @param recoveryId 0 or 1. Never the wire's `v`.
	 * @param r 32 bytes, big-endian.
	 * @param s 32 bytes, big-endian.
	 */
	ecrecover?(
		hash: Uint8Array,
		recoveryId: number,
		r: Uint8Array,
		s: Uint8Array,
	): Uint8Array | undefined;
}

/** Which EVM a node is running on (see {@link SlimNode.engine}). */
export interface EngineInfo {
	/** The engine's stable identifier, e.g. `'@ethereumjs/evm'`. */
	readonly id: string;
}

export interface NodeOptions {
	/** EIP-155 chain id. Default 31337 (anvil/hardhat-style local). */
	chainId?: number;
	/** State backing: `'none'` (fast, no trie/root — default) or `'trie'` (real
	 *  state root, slower; unlocks GeneralStateTests conformance). */
	stateMode?: StateMode;
	/**
	 * Sender derivation: `'recover'` (ecrecover, authenticated — DEFAULT) or
	 * `'trusted'` (skip ecrecover, trust a caller-supplied `from`). See
	 * {@link SenderMode}. `'trusted'` is ~6.2x faster per small tx on the default
	 * engine, ~2.8x with a revm engine installed (which recovers with its own
	 * secp256k1), and it lets ANY caller impersonate ANY address — opt in only for a
	 * local chain you control.
	 */
	senderMode?: SenderMode;
	/** Mining strategy. Default {type:'auto'}. */
	miningConfig?: MiningConfig;
	/** Optional persistence adapter (e.g. IndexedDB). */
	persistence?: PersistenceAdapter;
	/** Constant gas-fee values (slim node — no real fee market). */
	baseFeePerGas?: bigint;
	gasPrice?: bigint;
	maxPriorityFeePerGas?: bigint;
	/**
	 * Block gas limit. Default 30_000_000n, and a REAL limit: a transaction whose
	 * own gas limit exceeds it is refused (identically on every engine) rather than
	 * mined against a limit the block does not have. Raise it to admit bigger
	 * transactions; the block then really is that large, so `GASLIMIT` reports this
	 * number to a contract. It does NOT change the default `eth_call` read budget,
	 * which stays 30_000_000 (pass `gas` on the call for more).
	 */
	blockGasLimit?: bigint;
	/** Pre-fund accounts at genesis (address -> balance wei). */
	initialBalances?: Record<string, bigint>;
	/**
	 * Full genesis pre-state (address -> {balance, nonce, code, storage}). Richer
	 * than `initialBalances` (which only sets balance). Used to load an arbitrary
	 * starting state — e.g. a GeneralStateTest `pre` section — so that, in
	 * `stateMode:'trie'`, `getStateRoot()` after a tx can be compared to the
	 * fixture's expected post-state root. Applied at genesis, before block 0.
	 */
	initialState?: Record<string, GenesisAccount>;
	/**
	 * Override the header fields of MINED blocks. Lets a consumer run a tx under a
	 * specific block environment (coinbase, base fee, number, timestamp,
	 * prevRandao) — required to reproduce a GeneralStateTest `env` (the coinbase is
	 * credited tx fees, so it affects the post-state root). When omitted, the node
	 * uses its own constant fee market + a zero coinbase.
	 *
	 * GENESIS TAKES `coinbase` AND `prevRandao` FROM HERE TOO, and nothing else:
	 * they describe the CHAIN's environment rather than one block's position in it,
	 * so a block 0 that reported a zero miner while every block after it reported
	 * the configured one would be the same disagreement this option's two fields
	 * were made honest to remove. `number`, `timestamp` and `gasLimit` stay the
	 * node's own for block 0 — genesis IS block 0 by definition, and `blockEnv.number`
	 * exists to place a MINED block, not to renumber the genesis of the chain.
	 *
	 * Whatever is set here is REPORTED by `eth_getBlockByNumber` as `miner` and
	 * `mixHash`, and survives a `dumpState` / `loadState` round trip, so the block
	 * a consumer reads and the block a contract ran in cannot disagree.
	 */
	blockEnv?: BlockEnv;
	/**
	 * The EVM this node runs on, BOTH halves: reads (`eth_call`,
	 * `eth_estimateGas`, `eth_fillTransaction`'s estimation) through
	 * {@link Engine.call} and transactions through {@link Engine.transact}.
	 * Default: `@ethereumjs/evm`, i.e. exactly what the node has always run.
	 *
	 * An engine that implements only one half is refused at construction rather
	 * than half-served — see {@link Engine.transact}.
	 *
	 * An engine is passed as an OBJECT, never named by a string: the core must not
	 * reference engines it does not use, or a consumer of the JS-only path would
	 * pay (in bundle size) for an engine they never import. See
	 * `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.
	 */
	engine?: Engine;
}

/** A full genesis account (all fields optional except an implicit zero default). */
export interface GenesisAccount {
	balance?: bigint;
	nonce?: bigint;
	code?: string; // 0x-prefixed hex (omit/`0x` for EOA)
	storage?: Record<string, string>; // slot hex -> value hex
}

/** Mined-block header overrides (e.g. to honor a GeneralStateTest `env`). */
export interface BlockEnv {
	coinbase?: string;
	baseFeePerGas?: bigint;
	number?: bigint;
	timestamp?: bigint;
	gasLimit?: bigint;
	prevRandao?: string; // 0x-prefixed 32-byte hex (mixHash, post-Merge)
}

/** A slim node: transport-agnostic EIP-1193 + node-owned controls. */
export interface SlimNode {
	/** EIP-1193 request. Async ⇒ same object works on main thread or over comlink. */
	request(args: RequestArguments): Promise<unknown>;
	/** Mine one block now (only matters in manual/interval modes). */
	mine(): Promise<{blockNumber: number; blockHash: string; txHashes: string[]}>;
	/** Serialize all state to a plain object (live-set-sized; no trie/RLP walk). */
	dumpState(): Promise<SerializedState>;
	/** Restore state previously produced by dumpState (replaces current state). */
	loadState(state: SerializedState): Promise<void>;
	/** Subscribe to newHeads locally (used by eth_subscribe and consumers). */
	onNewHead(cb: (head: {number: number; hash: string}) => void): () => void;
	/**
	 * Current canonical state root. In `'trie'` mode this is the REAL
	 * Merkle-Patricia root (usable for GeneralStateTests conformance); in `'none'`
	 * mode the trie is absent so this throws (honest — there is no root to give).
	 */
	getStateRoot(): Promise<string>;
	/** The state mode this node was created with. */
	readonly stateMode: 'none' | 'trie';
	/** The sender mode this node was created with. */
	readonly senderMode: SenderMode;
	/**
	 * The engine this node was created with — `{id: '@ethereumjs/evm'}` unless one
	 * was injected. It answered this node's reads AND executed its transactions, so
	 * a receipt from this node can be attributed to this id.
	 */
	readonly engine: EngineInfo;
	/** Stop timers / release resources. */
	dispose(): Promise<void>;
}

/**
 * Slim, live-set-sized serialized state. No trie, no RLP state-root walk.
 *
 * `version` IS STILL 1 AFTER THE BLOCK HEADER GREW `miner` / `mixHash` /
 * `logsBloom` (2026-08-11), because those three fields were added as OPTIONAL
 * reads rather than as a new shape: a dump written by an older version carries
 * none of them and loads into this one unchanged (absent `miner` / `mixHash` read
 * as zero, and the bloom is rebuilt from the receipts the dump already carries).
 * A bump would have bought nothing a reader can act on and would have invalidated
 * every IndexedDB record in the wild for a format they can still be read as. Bump
 * it when a dump stops being loadable by the code that wrote it, which is the only
 * question `version` can usefully answer.
 */
export interface SerializedState {
	version: 1;
	chainId: number;
	/** State mode the dump was produced in (informational). */
	stateMode?: 'none' | 'trie';
	/** SimpleStateManager Maps: address -> hex-encoded account/code/storage. */
	accounts: Record<string, string>; // addr -> rlp/hex account
	code: Record<string, string>; // addr -> code hex
	storage: Record<string, Record<string, string>>; // addr -> (slot hex -> value hex)
	/** Block list (header fields we keep) keyed by number. */
	blocks: SerializedBlock[];
	/** Receipts keyed by tx hash. */
	receipts: Record<string, SerializedReceipt>;
	/** Raw tx + meta keyed by tx hash (for eth_getTransactionByHash). */
	transactions: Record<string, SerializedTx>;
}

export interface SerializedBlock {
	number: number;
	hash: string;
	parentHash: string;
	timestamp: number;
	gasUsed: string;
	gasLimit: string;
	baseFeePerGas: string;
	/** Real Merkle-Patricia state root in `'trie'` mode; zero placeholder in `'none'`. */
	stateRoot: string;
	/**
	 * The block's coinbase, under the name `eth_getBlockByNumber` reports it. Named
	 * for the RPC rather than for the header (`coinbase`) or the option
	 * ({@link BlockEnv.coinbase}) because this record exists to be SERVED: every
	 * other field here already carries its RPC name.
	 *
	 * OPTIONAL, and absent means the zero address — a dump written before this field
	 * existed has none. It is persisted rather than read off the `Block` object next
	 * to it because `loadState` rebuilds that object from THIS record, so a node that
	 * read the object would answer correctly until a reload and zero after one.
	 */
	miner?: string;
	/** The block's `mixHash`, i.e. post-Merge its PREVRANDAO. Absent means zero. */
	mixHash?: string;
	/**
	 * The block's logs bloom: the OR of its receipts' blooms, so a consumer
	 * pre-filtering blocks by it before calling `eth_getLogs` finds the logs that
	 * are really there. Absent (an older dump) means it is REBUILT on load from the
	 * receipts, which the dump carries either way.
	 */
	logsBloom?: string;
	transactions: string[]; // tx hashes
	logsCount: number;
}

export interface SerializedLog {
	address: string;
	topics: string[];
	data: string;
	blockNumber: number;
	blockHash: string;
	transactionHash: string;
	transactionIndex: number;
	logIndex: number;
}

export interface SerializedReceipt {
	transactionHash: string;
	transactionIndex: number;
	blockNumber: number;
	blockHash: string;
	from: string;
	to: string | null;
	contractAddress: string | null;
	cumulativeGasUsed: string;
	gasUsed: string;
	effectiveGasPrice: string;
	status: 0 | 1;
	type: number;
	logs: SerializedLog[];
	logsBloom: string;
}

export interface SerializedTx {
	hash: string;
	raw: string;
	from: string;
	to: string | null;
	nonce: number;
	value: string;
	input: string;
	type: number;
	blockNumber: number;
	blockHash: string;
	transactionIndex: number;
	gas: string;
	gasPrice: string | null;
	maxFeePerGas: string | null;
	maxPriorityFeePerGas: string | null;
}
