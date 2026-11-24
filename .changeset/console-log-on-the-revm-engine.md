---
'webevm': minor
---

Solidity `console.log` on `webevm/revm`: webevm now depends on `revm-wasm` `^0.6.0` (outcome format 5), and `createRevmEngine()` declares call recording (`recordsCalls: true`), passing the request's `recordCallsTo` to revm-wasm and mapping its `recordedCalls` back, present exactly when requested. `createNode({engine: await createRevmEngine({wasm}), consoleLog: consoleLog()})` therefore works and delivers the same entries as the default engine, with gas, receipts and state identical with console logging on and off; in a Worker, `exposeNode({createEngine, createConsoleLog})` together. The declaration is decided from the loaded artifact when the engine is built: a `wasm` older than outcome format 5 is still refused at construction on a console-logging node, naming the format it has and the one it needs, and keeps working on a node without console logging.
