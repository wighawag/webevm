---
'@webevm/devnode': patch
---

**The core's cheats and snapshots are proven to reach the node through a dev node.** `hardhat_setBalance` / `hardhat_setNonce` / `hardhat_setCode` / `hardhat_setStorageAt` and their `anvil_` names, `evm_mine`, `anvil_mine` / `hardhat_mine`, and `evm_snapshot` / `evm_revert` (and `anvil_snapshot` / `anvil_revert`) answer through a dev node exactly as on the bare node, on both engines, now that webevm's core serves them; the dev node forwards them and implements none. A revert also rolls back what the dev node reads, so a dev account that sent inside a snapshot's window sends again at the earlier nonce. No behaviour change: a new test file and a README note.
