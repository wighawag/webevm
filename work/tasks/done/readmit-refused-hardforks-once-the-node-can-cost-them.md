---
title: Re-admit a refused hardfork once the node can actually cost it
slug: readmit-refused-hardforks-once-the-node-can-cost-them
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

`webevm/revm` admits `shanghai` and `cancun` and refuses everything else by name at construction (`REVM_REFUSED_HARDFORKS`, `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and its amendment). Both refusals were the honest call, and the ADR says the door is not meant to stay shut: "nothing in this ADR argues Prague should stay unsupported forever", and it names `work/tasks/backlog/` as where the costing work belongs. This task is that placeholder, cut so a deliberate deferral does not quietly become permanent by neglect (raised by the Gate-2 reviews of `prague-intrinsic-gas-floor-or-refuse` and `intrinsic-gas-charges-eip-3860-on-forks-that-predate-it`).

**This task is NOT ready to build as written.** It is a marker with its entry conditions written down. It originally covered TWO families of refusal with different triggers; **family 2 was delivered on 2026-08-02, so only family 1 (`prague`, `osaka`) remains open.** Family 2 is retained below as history because it documents the inversion that makes ADR 0008's body misleading if read alone.

### Family 1: ABOVE the range (`prague`, `osaka`) is STILL blocked on OUR arithmetic

> **Checked against `revm-wasm@0.3.1` on 2026-08-02 and still blocked, both reasons verbatim.** The upstream fix note suggested these be re-evaluated for admission on the grounds that the EIP-7623 floor is now correctly present from Prague. That does not unblock them, and re-measuring says so directly: the node's estimate is still rejected with `GasFloorMoreThanGasLimit { gas_floor: 25000, gas_limit: 22600 }` on both, and the node's default 30M read budget is still rejected on Osaka with `TxGasLimitGreaterThanCap { gas_limit: 30021000, cap: 16777216 }`. Their refusal never depended on revm mis-charging anything; it depends on arithmetic this node does not implement, so a correct floor upstream makes the node's floor-less estimate MORE clearly wrong, not less. Do not re-admit these on the strength of the upstream fix.

`src/intrinsic-gas.ts` implements the pre-Prague formula only, while revm enforces more from Prague onwards. Measured in `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`:

- **EIP-7623 calldata floor** (Prague). A transaction pays at least `21000 + 10 * tokens` (1 token per zero byte, 4 per non-zero). For 100 non-zero calldata bytes the node computes 22600 and revm demands 25000, rejecting with `GasFloorMoreThanGasLimit`. Note the shape problem the code comment records: this is a floor on the transaction's TOTAL gas, not a term of the intrinsic formula, so it cannot be dropped inside `intrinsicGas()` without both callers also learning about it.
- **EIP-7825 gas cap** (Osaka). A transaction's gas limit is capped at 16777216, below the node's default read budget of 30000000, so EVERY ordinary `eth_call` is rejected with `TxGasLimitGreaterThanCap`. Independent of EIP-7623: solving the floor alone leaves Osaka just as broken.
- **EIP-7702 authorization lists and EIP-2935 block-hash history** (Prague) have never been checked against the node's transaction path. Re-admitting the fork claims those too.

> **BEFORE ADDING THE FLOOR, RECONSIDER THE SEAM. This is the tripwire for a decision that was deliberately deferred.** `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks` made the shared formula fork-aware by threading the node's `Common` into `intrinsicGas(data, isCreate, common)`. It considered and REJECTED a more drift-proof shape: moving intrinsic gas onto `ReadCallRequest`, so the node computes it ONCE and the engine merely reads it, making it structurally impossible for the ADD side and the SUBTRACT side to differ. That was deferred (ratified 2026-08-02) purely because it changes a PUBLIC seam type that third-party engines implement, and re-architecting the seam was out of proportion to threading one fork through it. The explicit condition for revisiting it was "if a second fork-dependent term ever arrives" — **and EIP-7623's floor is that term.** So evaluate the seam change FIRST and record the answer, rather than threading a second fork-dependent concern through the current shape by default. Note the floor is not even a term of the formula but a bound on the transaction's TOTAL gas, which is the case the current signature fits worst.

Entry conditions: the node wants to move its hardfork past Cancun, or a consumer asks for Prague/Osaka reads, or the node gains a hardfork option. Today `createNode()` pins `Hardfork.Cancun` and `NodeOptions` exposes no hardfork at all, which is why implementing the floor now would ship a branch no test going through the public API can execute. That unreachability is the argument that settled implement-vs-refuse the first time; if it still holds, STOP and say so.

### Family 2: BELOW the range (`berlin`, `london`, `paris`) is DONE

> **DELIVERED 2026-08-02 by `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks`** (`work/tasks/done/`). The repo is on `revm-wasm@^0.3.1`, `src/intrinsic-gas.ts` gates the EIP-3860 term on the node's `Common`, and all three forks are admitted again. ADR 0008's second amendment records it. **Nothing in this family is outstanding**; the section is kept because the reasoning below is the clearest statement of how a fork gets refused and un-refused, and because the inversion it documents is the trap a future reader of ADR 0008's body will otherwise fall into. Everything from here to the end of family 2 is HISTORY, not instructions.

> **The upstream fix landed, and it INVERTED the guidance below.** `wighawag/revm-wasm#4` is fixed in `revm-wasm@0.3.1`. Both probes were re-run against the shipped artifact and the results are in section 6 of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`. Read that section before doing anything here. In short: revm now gates EIP-3860 correctly, so **the node is the wrong party**, its estimates now DISAGREE with revm on these three forks (default 53302 vs revm 53298, protocol 53298), and **the local fork gate is now REQUIRED rather than forbidden**. The paragraph below explaining why not to gate locally was correct against `0.3.0` and is void against `0.3.1`; it is kept for the reasoning, not the instruction.

#### The original (pre-0.3.1) statement of the problem

Nothing about the node's own arithmetic is wrong here. `revm-wasm` computes intrinsic gas at a fixed late spec and CHARGES EIP-3860's initcode word cost on all three forks, which predate Shanghai. Both sides then agree on a number the protocol does not charge, over-charging by `2 * ceil(len/32)` gas (3072 for a maximum-size initcode). Measured in `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`; filed as **`wighawag/revm-wasm#4`**; tracked locally until it was DISCHARGED in `68f59e2`, its own condition having been met by the 0.3.1 upgrade; the measurement and the upstream fix now live in the spike doc named above.

~~**Do not try to fix this family locally.**~~ (VOID as of `0.3.1`, see the banner above.) The reasoning was: a fork gate in `src/intrinsic-gas.ts` would move the DEFAULT engine's estimate and could not move revm's (the engine subtracts the node's intrinsic gas from `totalGasSpent` and the node adds it straight back), converting an agreed-wrong number into a real cross-backend gas divergence. That held only while revm ALSO charged the term. Now that it does not, the same mechanism runs the other way: gating moves the default engine onto revm's (correct) number, and NOT gating leaves the two engines split.

Entry condition: **met.** `wighawag/revm-wasm#4` is fixed in `revm-wasm@0.3.1`, and both probes have been re-run against the shipped artifact (per-word delta is 4 on those specs, `gasUsed` equals `totalGasSpent` pre-Prague). What remains is the local work.

#### What family 2 now requires

1. Upgrade `revm-wasm` to `^0.3.1` in `packages/webevm` and `packages/benchmarks`, and update the lockfile. This is safe for the currently-admitted set on its own: `shanghai` and `cancun` are unaffected in every measured column.
2. **Gate the EIP-3860 initcode word cost by fork in `src/intrinsic-gas.ts`**, so it is charged from Shanghai onward and not before. This is the design question the task carries, and it is not free: `intrinsicGas(data, isCreate)` takes no fork today, and its whole value is that its two callers (`node.ts` adds it, `src/revm.ts` subtracts it) share ONE answer. Thread the fork through deliberately, keep the function SHARED and unforked, and record the seam decision.
3. Move `berlin`, `london`, `paris` from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK`, and drop the now-obsolete `PRE_EIP_3860` reason string.
4. Assert the restored agreement against the engine, and keep a still-refused fork as the counter-example so the assertions stay load-bearing.

Note the ORDER matters: upgrading to `0.3.1` WITHOUT gating leaves `berlin`/`london`/`paris` refused (so nothing user-visible breaks), but it does make the ungated term wrong against the engine for those specs. Do not re-admit before gating.

### Both families

The bar is the same either way, and ADR 0008 states it: implement whatever is missing in the SHARED `src/intrinsic-gas.ts` (shared so the node and the engine move together by construction, never forked) and in the engine's read budget, then move the entry from `REVM_REFUSED_HARDFORKS` to `REVM_SPEC_BY_HARDFORK` and let the existing test judge it. Re-admitting without doing the work is designed to fail loudly: `test/revm-engine.spec.ts` feeds the `eth_estimateGas` result back to revm AS a gas limit under every admitted spec.

**~~Check `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` before re-admitting anything.~~ DONE 2026-08-02 — the check is now WIDER than this paragraph assumed, and it is a tripwire you will trip.** That task landed (`work/tasks/done/`). Clause (b) is no longer enforced for the EIP-3860 term alone: `test/revm-engine.spec.ts` now measures all five terms the shared formula bakes in (transaction base, non-zero calldata byte, zero calldata byte, creation base, initcode word) three ways at every admitted fork, and ADR 0008's third amendment states that scope. Nothing needs hand-checking on EIP-2028 any more, and family 2 is delivered anyway.

What replaces the obligation is a live guard: the suite measures the EIP-2028 boundary from BOTH sides on two specs the engine does not admit, and ASSERTS the disagreement at `petersburg` (protocol 68, revm 68, node 16). So re-admitting anything below Istanbul moves that measured disagreement into the per-fork loop and fails the build, and correctly gating the calldata term on the `Common` will make the recorded `petersburg` reading fail too, deliberately: that reading is the evidence for the refusal, so the fix has to come back and update it. ADR 0008's third amendment lists what a re-admitter owes at each end of the range.

## Acceptance criteria

- [x] An entry condition for the family being re-admitted actually holds, and is stated in the work.
- [x] For each fork re-admitted, everything the node computes about a transaction (a) agrees with what revm enforces under that spec AND (b) is what the PROTOCOL charges at that fork, judged by a witness that is neither party, per ADR 0008's amended rule.
- [x] The agreement is asserted against the ENGINE rather than a restated formula, following the existing test's shape, and a still-refused fork remains as a counter-example so the assertions stay load-bearing.
- [x] Clause (b) is verified for EVERY term the shared formula bakes in, not just EIP-3860, either because `clause-b-covers-only-eip-3860-not-the-rest-of-the-formula` landed first or by explicit manual check recorded here.
- [x] `src/intrinsic-gas.ts` remains SHARED and unforked; if EIP-7623's floor cannot live inside `intrinsicGas()`, the seam it needs is designed deliberately rather than by duplicating the formula.
- [x] Family 1 only: Osaka is re-admitted only if the EIP-7825 cap is handled too, and Prague is not re-admitted on the strength of EIP-7623 alone while EIP-7702 / EIP-2935 are unchecked. That is the half-truth ADR 0008 refuses.
- [x] Family 2 only: the upstream fix is verified against the shipped artifact by re-running the probe, not taken from a changelog. (Delivered earlier by `upgrade-0-3-1-gate-eip-3860-and-readmit-pre-shanghai-forks`; not re-done here.)
- [x] The entry moves between the two tables, and ADR 0008 gains a short amendment recording that the refusal was lifted and on what evidence.
- [x] Cancun and Shanghai behaviour and the reference gas are demonstrably unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None mechanically, but see the entry conditions per family: this is DEFERRED work, not ready work. Do not auto-select it. Family 2 additionally depends on an upstream fix this repo does not control.

## Prompt

> Goal: lift one of ADR 0008's hardfork refusals by doing the work it defers, so the engine admits a fork because it can cost it rather than because nobody checked.
>
> FIRST, work out whether anything is worth doing AT ALL, and which family you are in. Read `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` INCLUDING its amendment, the entry conditions above, `createNode()` in `src/node.ts`, and `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`. (That last one REPLACES a pointer to `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md`, which was discharged by deletion in `68f59e2` once the 0.3.1 upgrade met its condition. Do not go looking for the note; the spike doc carries the measurement and the upstream state.) If the node still pins Cancun and nobody has asked for Prague, family 1 is still correctly deferred. If `wighawag/revm-wasm#4` is still open, family 2 is still blocked upstream and CANNOT be fixed here. In either case STOP and say so rather than implementing an unreachable branch or papering over an upstream bug: that judgement is the task, not a failure to do it.
>
> Re-run the probes in `docs/spikes/` rather than trusting numbers that may have aged with the package. For family 2 the probe IS the acceptance evidence.
>
> THE INVARIANT IS AGREEMENT WITH THE ENGINE AND WITH THE PROTOCOL, not a correct-looking formula. Two wrong sides that agree is the exact failure ADR 0008's amendment exists to catch, and it is how `berlin`/`london`/`paris` got refused in the first place. Extend the existing assertions instead of writing your own arithmetic to check the arithmetic.
>
> Do NOT fork `src/intrinsic-gas.ts`, and do NOT gate a term locally to work around an upstream mis-charge: on the revm path the engine subtracts what the node adds, so a local gate splits the two engines instead of fixing either.
>
> Done means: no hardfork the engine admits can have the node's estimate rejected by the engine that produced it, none is mis-costed against the protocol, and ADR 0008 records which refusal was lifted and why.

## Outcome

Family 1 is delivered: `prague` and `osaka` are in `REVM_SPEC_BY_HARDFORK`, `amsterdam` is the refused fork, and `createNode()` takes `hardfork: 'cancun' | 'prague' | 'osaka'` (default `'osaka'`). The entry condition that held is the third one listed above: the node gained a hardfork option, which also removes the unreachability argument that settled implement-vs-refuse the first time, since every new branch is now executed through the public API.

Per criterion:

- **The tripwire**, evaluated FIRST and recorded before implementing: `docs/adr/0015-the-forks-gas-rules-on-the-read-path-are-the-nodes-admission-and-intrinsic-gas-stays-off-the-seam.md`. Intrinsic gas does NOT move onto `ReadCallRequest`: neither the floor nor the cap is a term an engine subtracts, so the node applies both above the seam (read admission, estimate bounds, submit-time refusals) and the public seam types are unchanged.
- **Clause (a), against revm**: `test/revm-engine.spec.ts` takes the calldata-heavy estimate and the default read budget from a real node ON EACH offered fork, on both engines, and feeds them to revm under that fork's spec; accepted on all seven admitted forks. Counter-examples: Cancun's figures rejected by revm on Prague (`GasFloorMoreThanGasLimit`) and Osaka (`TxGasLimitGreaterThanCap`).
- **Clause (b), against the protocol**: the five-term readings run at `prague` and `osaka` and agree. The floor, the cap and EIP-7702 are judged end to end by `test/hardforks.spec.ts` and `test/revm-hardforks.spec.ts` (one set of literals for both engines, per fork), by the conformance differential, whose trie-backed `runTx` reference now runs the battery's fork (Osaka), and by the vendored GeneralStateTests, now run for their Prague cases too on a `hardfork: 'prague'` node (10/10 roots on each engine).
- **`src/intrinsic-gas.ts` stays shared and unforked**: the floor, the cap and the authorization charge are three new functions beside `intrinsicGas()`, gated on the node's `Common` like the EIP-3860 term.
- **Osaka's cap and Prague's EIP-7702 / EIP-2935** are handled, not skipped: see the Decisions below and ADR 0008's fourth amendment.
- **Reference gas unchanged**: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`, asserted by `packages/benchmarks` with the slim node on its new default (Osaka) against the Cancun backends.
- **Bundle size**: the default entry grew 442.7 -> 448.5 KB raw, re-pinned in `packages/benchmarks/test/evm.spec.ts` with the reason.

## Decisions

1. **The default fork is `'osaka'`**, as asked: the latest fork the node can cost. A consumer who passes nothing now runs Osaka (a transaction above 16,777,216 gas is refused; calldata-heavy transactions cost the floor). `'cancun'` keeps the old behaviour. Minor bump in the changeset.
2. **The option is a closed list of three**, not every fork `@ethereumjs/common` names: a fork is offered only where the node's own rules are implemented and tested on both engines. Earlier forks are reachable on the revm engine by hand (its table is unchanged below Cancun) but not through `createNode()`.
3. **An `eth_call` cannot exceed the cap on Osaka, on either engine**, stricter than geth (which lifts the cap for `eth_call`): `revm-wasm` has no switch to lift it, and lifting it on one engine would split the two. The default read budget shrinks to the cap less the read's intrinsic gas; an explicit `gas` over it is refused with `-32000`. Lifting it needs a `revm-wasm` switch first. Recorded in ADR 0015.
4. **An estimate with an access or authorization list over-states by at most those lists' charges when the floor decides it**, identically on both engines, because the read request carries no lists and revm refuses a read whose own total is below the floor. Recorded in ADR 0015.
5. **A read carrying an `authorizationList` runs with its delegations applied above the seam** (`withAuthorizations` in `src/node.ts`), following `runTx`'s validity rules, so an estimate executes the delegated code; without it the common self-sponsored or sponsored type-4 estimate would be a bare transfer. Not modelled: the 12,500 refund per existing authority and the warming of authorities, both in the safe direction.
6. **EIP-2935 (and EIP-4788 before it) system writes are not performed.** `BLOCKHASH` is unchanged at Prague (the contract-backed one is EIP-7709, which no offered fork has), the node runs no block-start system call, and the history contract is absent unless a genesis puts it there, in which case it is never written. Documented on `NodeOptions.hardfork` and in the README. EIP-7002 / EIP-7251 requests are likewise never produced.
7. **The fork is part of the chain**: `dumpState()` records it, `loadState()` refuses another fork's dump, and an unlabelled dump is Cancun's. A chain persisted by an earlier version therefore needs `hardfork: 'cancun'`, and otherwise fails construction naming the option, with the stored chain untouched (the alternative, silently starting fresh, would overwrite it on the next save).
8. **Three refusals moved above the parser, in geth's words**: a gas limit above the cap (`transaction gas limit too high`, read off the RLP because `@ethereumjs/tx` throws in its constructor), a type-4 transaction before Prague (`transaction type not supported`), and a gas limit below the floor (`insufficient gas for floor data gas cost`, at submit, after the intrinsic check).
9. **Test fixtures that ran on the node's implicit Cancun now say which fork they mean**: the old-dump fixtures load into `hardfork: 'cancun'` nodes, the block-gas-limit conformance step runs its two nodes on Prague (on Osaka the cap pre-empts any limit above 16,777,216) and gains an Osaka node asserting the cap refusal, the engine-seam stub node uses a 10M block gas limit for the same reason, and the root-update benchmark runs on Prague (its largest block is one 22.1M-gas transaction).
10. **The fork probe in `test/helpers/revm-engine.ts` reads the fork of the nodes under test** (it is built with their options), which discharges `work/notes/observations/the-fork-probe-derives-createnodes-default-fork-not-the-node-under-test.md`, deleted in the same change.
