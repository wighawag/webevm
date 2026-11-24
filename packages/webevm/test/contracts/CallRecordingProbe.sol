// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// The fixture for CALL RECORDING at the engine seam (`recordCallsTo` /
/// `recordedCalls`, docs/adr/0018-console-log-is-observed-never-answered.md):
/// a contract that calls a TARGET address every way the EVM can, so a test can
/// read back which of those frames an engine recorded, in which order.
///
/// THE TARGET IS A PARAMETER, never the console address baked in: the seam
/// records calls to whatever address it is given and decodes nothing, so the
/// fixture must not be able to pass only because one address is special.
///
/// EVERY FRAME CARRIES ITS OWN ONE-BYTE PAYLOAD, so a recording is readable as a
/// sequence of markers: `01` CALL, `02` STATICCALL, `03` DELEGATECALL, `04`
/// CALLCODE, `05` the CALL inside a sub-call that then REVERTS, `06` a CALL whose
/// value this contract cannot afford (refused before it runs, so it must NOT
/// appear), `07` a CALL after all of them. `08` is the CALL inside a whole
/// transaction that reverts, `09` the CALL into a contract this one has just
/// CREATE2'd (the creation frame itself must not appear).
///
/// Its OWN contract, rather than more functions on an existing probe, for the
/// reason `DiscardedLogProbe` gives: growing a shared fixture moves its deploy
/// gas and therefore another suite's absolute pins.
contract CallRecordingProbe {
    /// Written on every `callEveryKind`, so a transaction has a post-state to
    /// compare with and without recording.
    uint256 public runs;

    /// Emitted on every `callEveryKind`, so a transaction has a log (and a
    /// bloom) to compare with and without recording.
    event Ran(uint256 indexed runs);

    /// Every recordable frame kind into `target`, in marker order, plus the two
    /// frames that must not be recorded (`06`, refused before it runs) and must
    /// be recorded although they die (`05`, inside a reverting sub-call).
    function callEveryKind(address target) public returns (uint256) {
        runs += 1;
        bool ok;
        (ok, ) = target.call(hex"01");
        (ok, ) = target.staticcall(hex"02");
        (ok, ) = target.delegatecall(hex"03");
        assembly {
            mstore8(0, 0x04)
            ok := callcode(gas(), target, 0, 0, 1, 0, 0)
        }
        (ok, ) = address(this).call(
            abi.encodeWithSelector(this.callThenRevert.selector, target, hex"05")
        );
        require(!ok, "sub-call did not revert");
        // One wei more than this contract holds: `_baseCall` (and revm) refuse
        // the frame before it exists, so nothing runs and nothing is recorded.
        (ok, ) = target.call{value: address(this).balance + 1}(hex"06");
        require(!ok, "unaffordable call succeeded");
        (ok, ) = target.call(hex"07");
        emit Ran(runs);
        return runs;
    }

    /// CALLs `target` with `payload`, then REVERTS: as a sub-call above, and as
    /// a whole transaction of its own (payload `08`).
    function callThenRevert(address target, bytes memory payload) public {
        (bool ok, ) = target.call(payload);
        ok;
        revert("reverted after the call");
    }

    /// CREATE2s an empty contract, CALLs it with `09`, and returns its address.
    /// Recording calls to that address must yield `09` alone: the creation frame
    /// has no code address to match, and a CREATE is never recorded.
    function createThenCall(bytes32 salt) public returns (address created) {
        created = address(new Empty{salt: salt}());
        (bool ok, ) = created.call(hex"09");
        ok;
    }
}

/// The CREATE2 target. It has no fallback, so the `09` call into it REVERTS,
/// which is one more frame recorded whatever its outcome.
contract Empty {}
