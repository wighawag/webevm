---
'@webevm/devnode': minor
---

`wrapDevNode` (and so `createDevNode`) forwards webevm's new `onConsoleLog` member to the wrapped node, so a dev node created with `consoleLog` delivers Solidity `console.log` entries to its subscribers as the node does.
