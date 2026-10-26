---
'webevm': minor
---

**Every log carries `blockTimestamp`.** Logs from `eth_getLogs` and inside receipts (`eth_getTransactionReceipt`, and the receipt `eth_sendRawTransactionSync` returns) now include `blockTimestamp`, the timestamp of the block the log is in, as a hex quantity equal to that block's `timestamp` from `eth_getBlockByNumber` / `eth_getBlockByHash`. This is the field execution-apis#639 added to the log object, already served by geth (>= 1.16), reth, besu, erigon, anvil and Hardhat's EDR (>= 0.20); indexers that refuse a log without it (etherfold's `TimestamplessLogError`) now index a webevm chain. It is read from the block at serve time rather than stored on each log, so the `dumpState` format is unchanged and every dump, including one written by an earlier version and one restored by IndexedDB persistence, answers with it. The default entry grows by 0.1 KB raw (gzip unchanged).
