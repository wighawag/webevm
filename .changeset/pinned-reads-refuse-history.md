---
'webevm': minor
---

**Request parameters the node used to ignore are now honoured, or refused loudly.** Each of these answered a different question from the one asked, with no error:

- **The block parameter of state reads.** `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt` and `eth_getTransactionCount` ignored it and answered from the head, while `eth_getLogs` and `eth_getBlockByNumber` honoured theirs. A client that pins logs and a view call to the same block, so the two describe one moment, got logs as of that block and storage as of a later one. This node keeps only the state at its head, so those methods now serve the head (`latest`, `pending`, `safe`, `finalized`, an omitted block, or a number, hash or EIP-1898 object naming the head block) and refuse anything else: `-32000 historical state not available` below the head, `-32000 header not found` above it or for an unknown hash, `-32602` for a parameter that is not a block.
- **State overrides** (third parameter of `eth_call` and `eth_estimateGas`). Now applied for that request only (`balance`, `nonce`, `code`, `state`, `stateDiff`), on both engines and in both state modes. Any other override field, and block overrides (fourth parameter), are refused with `-32602`.
- **`eth_getLogs` `blockHash`.** It returned the logs of every block. Now it returns that block's logs; an unknown hash is `-32000` and a hash together with `fromBlock`/`toBlock` is `-32602`.
- **`eth_feeHistory` `newestBlock`.** The window always ended at the head. Now it ends at the block asked for (above the head is `-32000`), it is clamped at genesis and at 1024 blocks as geth clamps it (so a chain shorter than `blockCount` returns fewer entries, where it used to pad with blocks that do not exist), and `baseFeePerGas` and `gasUsedRatio` are the blocks' real values instead of constants.
- **The `pending` nonce.** `eth_getTransactionCount(addr, 'pending')` and the nonce `eth_fillTransaction` fills ignored queued transactions, so under `manual`/`interval` mining two sends before a mine got the same nonce and the second was refused at mine time as a replay. Both now count the sender's queued transactions.
- **Malformed input is `-32602`**, not a JavaScript `SyntaxError`: a junk block tag (`eth_getBlockByNumber('yesterday')`, `eth_getLogs` ranges), a block hash where a number is expected, a junk `eth_feeHistory` `blockCount`, and malformed or oversized state-override values (which used to be silently truncated to 32 bytes).

A `minor` because requests that used to return a (wrong) value now throw, and `eth_feeHistory`'s values change.
