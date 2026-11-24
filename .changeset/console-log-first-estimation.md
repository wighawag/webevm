---
'webevm': minor
---

`consoleLog({estimateGas: 'first'})` opts estimation into console logging: `eth_estimateGas` and `eth_fillTransaction` deliver the entries of the estimation search's FIRST execution only (the top probe at the search's cap), tagged `source: 'eth_estimateGas'` or `source: 'eth_fillTransaction'`, before the estimate is returned or its error thrown, however many probes the search makes. The default, `'none'`, keeps estimation silent. The estimate is identical with the option on and off, and an estimation refused before any probe executes delivers nothing. Any other value is refused by `consoleLog()`, and a `consoleLog` object carrying one is refused at `createNode()`. The default entry grows by 0.2 KB raw (the node half only; the decoder stays in the subpath). See `docs/adr/0018-console-log-is-observed-never-answered.md`.
