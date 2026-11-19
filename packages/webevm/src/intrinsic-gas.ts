/**
 * intrinsic-gas.ts — the transaction's INTRINSIC gas, in one place.
 *
 * 21000 base, plus 16 per non-zero and 4 per zero calldata byte (EIP-2028, from
 * Istanbul on), plus (for a creation) 32000 and, from Shanghai on, the EIP-3860
 * initcode word cost.
 *
 * It lives on its own because TWO callers need the same answer and a silent
 * disagreement between them is expensive: `node.ts` ADDS it to whatever the read
 * engine reports (an engine reports EXECUTION gas only), and
 * `webevm/revm` SUBTRACTS it, because revm charges intrinsic gas
 * itself out of the transaction gas limit while `@ethereumjs/evm`'s `runCall`
 * charges none. Two copies of this formula would drift and the drift would show
 * up as an `eth_estimateGas` that differs by engine.
 *
 * WHAT IT IS NOT: A TRANSACTION'S VALIDITY FLOOR. This formula answers the READ
 * path's question — how much gas a call costs before execution, so the node can
 * add it to what an engine reports and the revm engine can subtract it — and
 * SIGNED CALLDATA IS ALL IT KNOWS ABOUT, so there is no access-list term in it. A
 * TRANSACTION pays one: 2,400 per address and 1,900 per storage key, which both
 * engines charge, so this figure is 6,200 gas short of the floor for a type-1
 * transaction naming one address and two keys. The node therefore refuses a gas
 * limit below intrinsic gas against the parsed transaction's OWN
 * `getIntrinsicGas()` (`refuseIfBelowIntrinsicGas` in ./node.ts), which is also
 * the figure `runTx` validates against. Two questions, two figures, both the
 * node's, neither a copy of the other; measured side by side on four transaction
 * shapes in
 * `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`.
 * Do not "unify" them by adding an access-list term to {@link intrinsicGas}: the
 * two callers that share this formula must stay in lockstep, and the revm engine
 * SUBTRACTS whatever it returns from a read whose engine request carries no access
 * list at all, so an extra term there would be subtracted from a figure that never
 * contained it. An `eth_estimateGas` REQUEST may nevertheless name an access list
 * (geth's `accessList` field, and viem sends it), so the charge for THAT lives
 * beside this formula rather than inside it: see {@link accessListGas}.
 *
 * WHY THE FORK IS A `Common` AND NOT A HARDFORK NAME. The formula has a
 * fork-dependent term, so both callers have to name the same fork — and the
 * cheapest way to guarantee that is not to compare two names but to pass ONE
 * OBJECT. `node.ts` builds the node's `Common` and hands that very instance to
 * the engine through the seam (`EngineContext.common`), so the two callers
 * are asking the SAME `Common` the same question and cannot disagree even in
 * principle. It is also the right authority rather than merely a convenient one:
 * `common.isActivatedEIP()` is the table `@ethereumjs/vm`'s `runTx` consults, so
 * the read path charges a deployment exactly what this node's own transaction
 * path spends on it. A hardfork NAME would have meant a second activation table
 * in this repo — a fresh copy of the knowledge that EIP-3860 arrived in
 * Shanghai, which is precisely the drift this file exists to prevent. See
 * `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 *
 * THE FORK RANGE THIS FORMULA IS TRUE FOR IS ISTANBUL..OSAKA, AND IT HAS AN END
 * AT BOTH SIDES. The node runs Cancun, Prague or Osaka (`NodeOptions.hardfork`);
 * `webevm/revm` admits Berlin..Osaka, which sits strictly inside that range.
 * Every term above is measured against the protocol at every admitted fork by the
 * clause-(b) assertions in `test/revm-engine.spec.ts`; the two ends are where the
 * formula stops being true, so they are what anyone moving the node's hardfork
 * owes.
 *
 * FROM PRAGUE ON, THREE MORE RULES, AND NONE OF THEM IS A TERM OF THIS FORMULA.
 * EIP-7623's calldata floor ({@link calldataFloorGas}) bounds a transaction's
 * TOTAL from below, EIP-7825's cap ({@link transactionGasLimitCap}, Osaka) bounds
 * its gas LIMIT from above, and EIP-7702's per-authorization charge
 * ({@link authorizationListGas}) is paid only by a transaction that carries an
 * authorization list, which a read request never does. So they sit BESIDE this
 * formula and are applied by the node alone, above the engine seam: the node
 * never hands an engine a read whose total is below the floor, and the one number
 * an engine needs, this one, is unchanged. Moving intrinsic gas
 * onto the seam's read request instead was evaluated and rejected; see
 * `docs/adr/0015-the-forks-gas-rules-on-the-read-path-are-the-nodes-admission-and-intrinsic-gas-stays-off-the-seam.md`.
 * AT AMSTERDAM the formula stops being true (EIP-8037 splits intrinsic gas into
 * two dimensions, EIP-7976 re-prices calldata tokens), which is why that fork is
 * refused by name.
 *
 * BELOW, AT ISTANBUL: the 16 above is EIP-2028's, which shipped in Istanbul, and
 * it is hardcoded here rather than gated. Before Istanbul a non-zero calldata
 * byte costs 68, so on a pre-Istanbul fork this formula would UNDER-charge by 52
 * gas per non-zero byte — and an under-estimate is the direction that reaches a
 * user, since a client uses `eth_estimateGas` as the transaction's gas limit.
 * The term is NOT fork-gated on purpose: no admitted fork predates Istanbul and
 * none can, because a fork in neither of ./revm.ts's two tables is refused by the
 * "no revm spec is known" guard, so a gate would be arithmetic nothing can reach
 * (the same argument that keeps the EIP-7623 floor out). What stands in its place
 * is a measurement rather than a comment: the suite measures this term either
 * side of the Istanbul boundary (`petersburg` and `istanbul`), so re-admitting a
 * pre-Istanbul fork turns that measured disagreement into a failing build. If one
 * is ever re-admitted, gate this term the way the EIP-3860 one is gated, on the
 * `Common` — do not simply widen the tables.
 *
 * The fork gate on the EIP-3860 term is, by contrast, reachable and load-bearing:
 * it is what makes Berlin, London and Paris admissible, because `revm-wasm@0.3.1`
 * gates the term correctly and an unconditional term here would make
 * `eth_estimateGas` for a deployment differ BY ENGINE on those three forks (the
 * default engine's estimate moves with this formula; the revm engine's is revm's
 * own number, since it subtracts this intrinsic and the node adds it back).
 * Measured both ways, before and after the upstream fix, in
 * `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`; every
 * term of this formula measured fork by fork in
 * `docs/spikes/clause-b-covers-only-eip-3860-not-the-rest-of-the-formula/`.
 *
 * Either way: anyone moving the node's hardfork has to do this arithmetic first;
 * see `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md`.
 */
import type {Common} from '@ethereumjs/common';

export function intrinsicGas(
	data: Uint8Array,
	isCreate: boolean,
	common: Common,
): bigint {
	let gas = 21_000n;
	// EIP-2028 (Istanbul): 16 per non-zero calldata byte, 4 per zero one. Hardcoded
	// rather than asked of `common`, unlike the EIP-3860 term below — see the
	// header: no fork this engine admits predates Istanbul, and none can.
	for (const b of data) gas += b === 0 ? 4n : 16n;
	if (isCreate) {
		gas += 32_000n;
		// EIP-3860 (Shanghai): 2 gas per 32-byte initcode word. Asked of the node's
		// own `Common` rather than gated on a fork name, so this charge lands
		// exactly where `@ethereumjs/vm`'s `runTx` charges it on the write path.
		if (common.isActivatedEIP(3860)) {
			gas += BigInt(Math.ceil(data.length / 32)) * 2n;
		}
	}
	return gas;
}

/** EIP-7623: what one calldata TOKEN costs under the floor. */
const TOTAL_COST_FLOOR_PER_TOKEN = 10n;

/**
 * EIP-7623 (Prague): THE LEAST A TRANSACTION WITH THIS CALLDATA PAYS, whatever it
 * executes: `21000 + 10 * tokens`, a zero byte being one token and a non-zero byte
 * four. `0n` on a fork without EIP-7623, so a caller can take `max(.., floor)`
 * unconditionally.
 *
 * A FLOOR ON THE TOTAL, NOT A TERM. A transaction is charged
 * `max(intrinsic + execution - refund, floor)`, and its gas LIMIT must be at
 * least the floor before it may start (`INTRINSIC_GAS_TOO_LOW` on
 * `@ethereumjs/vm`, `GasFloorMoreThanGasLimit` on revm,
 * `insufficient gas for floor data gas cost` on geth). The access list does not
 * enter it at Prague or Osaka (EIP-7981, which adds it, is Amsterdam's).
 *
 * Gated on the node's `Common` by `isActivatedEIP(7623)`, for the reason the
 * EIP-3860 term above is: that is the table `runTx` consults when it applies the
 * same floor to a mined transaction.
 */
export function calldataFloorGas(data: Uint8Array, common: Common): bigint {
	if (!common.isActivatedEIP(7623)) return 0n;
	let tokens = 0n;
	for (const b of data) tokens += b === 0 ? 1n : 4n;
	return 21_000n + TOTAL_COST_FLOOR_PER_TOKEN * tokens;
}

/** EIP-7825 (Osaka): the largest gas limit a single transaction may carry. */
const MAX_TRANSACTION_GAS_LIMIT = 16_777_216n;

/**
 * EIP-7825 (Osaka): THE LARGEST GAS LIMIT ONE TRANSACTION MAY CARRY, 2^24, or
 * `undefined` on a fork without the cap. A limit above it is refused outright by
 * every party (`@ethereumjs/tx` at construction, revm with
 * `TxGasLimitGreaterThanCap`, geth with `transaction gas limit too high`); it is
 * never trimmed. The node applies it to what it ADMITS and RECOMMENDS: a
 * transaction above it is refused at submit, and `eth_estimateGas` never searches
 * above it. A READ is not held to it, as geth's `eth_call` is not: the default
 * engine's `runCall` never enforced it, and the revm engine lifts it on its reads
 * (`disableTxGasLimitCap`).
 */
export function transactionGasLimitCap(common: Common): bigint | undefined {
	return common.isActivatedEIP(7825) ? MAX_TRANSACTION_GAS_LIMIT : undefined;
}

/** EIP-7702: what one authorization costs up front (`PER_EMPTY_ACCOUNT_COST`). */
const PER_AUTHORIZATION_COST = 25_000n;

/**
 * WHAT AN `eth_estimateGas` REQUEST'S EIP-7702 AUTHORIZATION LIST COSTS UP FRONT:
 * 25,000 per entry, the charge a type-4 transaction pays before its first opcode
 * (`@ethereumjs/tx`'s `getIntrinsicGas()` includes it, which is the floor the
 * node refuses a submitted transaction against). The 12,500 refunded for an
 * authority that already exists is NOT subtracted: the estimate over-states by
 * that much, which is the safe direction for a number a client uses as a gas
 * limit.
 *
 * Beside {@link intrinsicGas} rather than inside it for the reason
 * {@link accessListGas} is: the engine seam's read request carries no
 * authorization list, so a term in the shared formula would be subtracted by the
 * revm engine from a figure that never contained it. `0n` for anything that is
 * not an array, so an untyped request cannot make an estimate throw here.
 */
export function authorizationListGas(authorizationList: unknown): bigint {
	if (!Array.isArray(authorizationList)) return 0n;
	return BigInt(authorizationList.length) * PER_AUTHORIZATION_COST;
}

/** EIP-2930: what one access-list entry's ADDRESS costs, up front. */
const ACCESS_LIST_ADDRESS_COST = 2_400n;
/** EIP-2930: what one access-list STORAGE KEY costs, up front. */
const ACCESS_LIST_STORAGE_KEY_COST = 1_900n;

/**
 * WHAT AN `eth_estimateGas` REQUEST'S ACCESS LIST COSTS: 2,400 per address plus
 * 1,900 per storage key, the EIP-2930 charge, added to {@link intrinsicGas} by
 * `eth_estimateGas` alone.
 *
 * ## Why it is a SECOND function rather than a term of the formula above
 *
 * {@link intrinsicGas} has exactly two callers and they must not drift: `node.ts`
 * ADDS it to the EXECUTION gas an engine reports, and `webevm/revm`
 * SUBTRACTS it from revm's total. The engine seam's read request
 * (`ReadCallRequest`) carries NO access list (a read is executed with none on
 * either engine), so a term added to the shared formula would be subtracted from a
 * number that never included it, and `eth_estimateGas` would come out 6,200 gas
 * short on revm and 6,200 long on `@ethereumjs/evm` for the same request. The
 * charge therefore sits ABOVE the seam, added once by the one caller that has a
 * request to read it off.
 *
 * ## Why `eth_estimateGas` charges it at all
 *
 * BECAUSE THE NODE'S OWN REFUSAL POINTS THE CALLER HERE. A transaction whose gas
 * limit is below the intrinsic floor is refused with "raise the gas limit to at
 * least N", pointing the caller at `eth_estimateGas` for the number a transaction
 * needs (`refuseIfBelowIntrinsicGas` in ./node.ts), and that floor is the
 * transaction's own `getIntrinsicGas()`, WHICH INCLUDES THE ACCESS LIST. An estimate blind to
 * the list answered 21,000 for a type-1 transaction with a floor of 27,200: the
 * node would refuse the very number it had just recommended. It is also what geth
 * does (`eth_estimateGas` honours the request's `accessList` field), so a client
 * that sends one gets the same answer here as from a real node.
 *
 * ## It OVER-estimates a list whose entries are touched, deliberately
 *
 * The charge is added, but the WARMING is not modelled: the read underneath was
 * executed without the list, so an access to a listed entry inside it was priced
 * COLD (2,600 / 2,100) where the mined transaction pays WARM (100). The estimate
 * is therefore up to 2,500 per touched address and 2,000 per touched key ABOVE
 * what the transaction really costs. That is the SAFE direction: a client uses
 * the estimate as its gas limit, so an over-estimate costs nothing (unused gas is
 * not charged) while an under-estimate is a transaction that runs out of gas.
 * Buying the exact figure would mean widening the read seam to carry an access
 * list and pre-warming it on both engines, which is a change to the seam, not to
 * an estimate. Both figures are measured and pinned in
 * `test/revm-access-list.spec.ts`, and the run in which the node refused the very
 * gas limit it had just recommended is kept in
 * `docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md`.
 *
 * ## What does NOT charge it, and why that is not an oversight
 *
 * `eth_fillTransaction` estimates with {@link intrinsicGas} alone, because the
 * transaction it FILLS AND RETURNS carries no access list (it builds a type-0 or
 * type-2 envelope and drops the field): charging for a list its own answer does
 * not contain would hand back a gas limit for a different transaction.
 */
export function accessListGas(accessList: unknown): bigint {
	if (!Array.isArray(accessList)) return 0n;
	let gas = 0n;
	for (const entry of accessList) {
		// TOLERANT OF THE ENTRY, STRICT ABOUT THE ARITHMETIC: this reads an unvalidated
		// JSON-RPC parameter, and an entry naming no keys (`{address}` with
		// `storageKeys` omitted) is a legitimate access list, not an error. What must
		// never happen is a THROW here, which would turn a merely odd request into a
		// failed estimate.
		if (entry === null || typeof entry !== 'object') continue;
		gas += ACCESS_LIST_ADDRESS_COST;
		const keys = (entry as {storageKeys?: unknown}).storageKeys;
		if (Array.isArray(keys))
			gas += BigInt(keys.length) * ACCESS_LIST_STORAGE_KEY_COST;
	}
	return gas;
}
