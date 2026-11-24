// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {console} from "../fixtures/console-log/hardhat/console.sol";

/// The fixture for Solidity `console.log` THROUGH THE NODE
/// (`createNode({consoleLog})`, docs/adr/0018-console-log-is-observed-never-answered.md):
/// a contract that logs, through the vendored, pinned Hardhat `console.sol`,
/// everywhere a consumer would expect a line to appear: in its constructor, in a
/// transaction, in a view read, inside a sub-call that reverts, and in a
/// transaction that reverts as a whole. It also calls the console address with
/// MALFORMED calldata, which must deliver nothing and fail nothing.
///
/// Its OWN contract, rather than more functions on an existing probe, for the
/// reason `DiscardedLogProbe` gives: growing a shared fixture moves its deploy
/// gas and therefore another suite's absolute pins.
contract ConsoleLogProbe {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    /// Written by every transaction, so a transaction has a post-state (and a
    /// state root) to compare with console logging on and off.
    uint256 public count;

    /// Emitted by `work`, so the comparison covers a real EVM event log, which
    /// IS receipt data, unlike a console call.
    event Counted(uint256 indexed count);

    constructor() {
        console.log("deployed by %s", msg.sender);
    }

    /// Logs, makes a sub-call that logs and then reverts, and logs again.
    function work(uint256 n) public returns (uint256) {
        count += n;
        console.log("work", n, count);
        try this.failInside(n) {} catch {}
        console.log("after the failed sub-call", true);
        emit Counted(count);
        return count;
    }

    /// Logs, then reverts: called by `work` as a sub-call.
    function failInside(uint256 n) external pure {
        console.log("inside a sub-call that reverts, n =", n);
        revert("sub-call reverts");
    }

    /// Writes, logs, then reverts the whole transaction.
    function failWhole(string memory why) public {
        count += 1;
        console.log("about to revert:", why);
        revert(why);
    }

    /// A view that logs: read with `eth_call`.
    function peek(address who) public view returns (uint256) {
        console.log("peek by", who, "count", count);
        return count;
    }

    /// Calls the console address three MALFORMED ways (an unknown selector, a
    /// `log(uint256)` whose argument is truncated, fewer than four bytes) and
    /// nothing well-formed, then writes, so the transaction has an effect to
    /// check while delivering no entry.
    function malformed() public returns (uint256) {
        bool ok;
        (ok, ) = CONSOLE.staticcall(hex"deadbeef");
        (ok, ) = CONSOLE.staticcall(
            abi.encodePacked(bytes4(keccak256("log(uint256)")), bytes16(0))
        );
        (ok, ) = CONSOLE.staticcall(hex"f8");
        ok;
        count += 1;
        return count;
    }
}
