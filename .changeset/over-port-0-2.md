---
'webevm': patch
---

**Depends on `@eip-1193/over-port` `^0.2.0`.** 0.1.0 required eip-1193 at exactly 0.7.1, the release that declared `engines.pnpm >=11` by mistake, so installing webevm pulled that copy in next to whatever eip-1193 the app used. 0.2.0 requires `^0.7.2`, so an app on eip-1193 0.7.3 now gets a single copy. `node.serveOn(port)` serves exactly what it did (it uses only `serveProvider`, whose behaviour and types did not change), and webevm's own published types do not mention over-port, so nothing changes for a consumer of webevm. A check that every package webevm's published declarations import is a declared dependency now runs in CI and in `prepublishOnly`, so before every publish.
