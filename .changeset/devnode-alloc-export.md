---
'@webevm/devnode': minor
---

**`toAllocs(dump)`: a webevm dump as the genesis alloc forge's `vm.loadAllocs` accepts**, so a `forge test` loads a deployment made on a dev node instead of replaying it. The result is `{address: {nonce, balance, code, storage}}`, nonces and balances as hex quantities (decoded from each account's RLP), code as hex, storage keyed by 32-byte slots with values padded to 32 bytes; every account in the dump is exported, the funded dev accounts included, and the storage root and code hash are dropped (forge recomputes both). It is a pure function of the dump, so it runs in Node as in a browser, on any dump (persisted ones and `senderMode: 'trusted'` chains included), and throws on a malformed one, naming the address and field. A manual script, `scripts/forge-load-allocs.mjs`, runs a real `forge test` against an export; it passed under forge 1.7.1.
