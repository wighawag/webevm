---
'@webevm/devnode': patch
---

The README documents that `createDevNode` passes webevm's `consoleLog` option to the node it creates and that `onConsoleLog` on a dev node is the node's own: a subscriber receives the entries of the transactions and reads that go through the dev node, a dev account's `eth_sendTransaction` included, and on a node without console logging it throws the node's own error.
