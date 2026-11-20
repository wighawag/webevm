<!-- dorfl-sidecar: item=task:devnode-eth-send-transaction-from-dev-accounts type=task slug=devnode-eth-send-transaction-from-dev-accounts allAnswered=false -->

## Q1

**'task:devnode-eth-send-transaction-from-dev-accounts' was bounced — how should we proceed?**

> Dependency approval needed. The task says "Sign with `@ethereumjs/tx`" and "Ask before adding a dependency not named in this task or in ADR 0017", and there was no supervisor to ask. `@ethereumjs/tx` signs against an `@ethereumjs/common` `Common`. Without one it defaults to Mainnet (chain ID 1): typed transactions (types 1, 2 and 4) throw "Common chain ID ... not matching", and legacy EIP-155 signatures would carry chain ID 1. Building a type 4 transaction also needs a `Common` with EIP-7702 active (Prague). So the dev node, which runs on the node's own chain ID (31337 by default), needs `new Common({chain: {...Mainnet, chainId}, hardfork: 'prague'})` from `@ethereumjs/common`. That package is NOT in ADR 0017's approved list or in packages/devnode/package.json. It is already in the install tree: a dependency of `@ethereumjs/tx` itself and of `webevm`, at ^10.1.2. Importing it without declaring it would also fail scripts/check-type-deps.mjs. The only alternative without it is rebuilding a `Common` from `createTx(...).common.constructor` and its public getters, which I judge too fragile to ship. Suggested resolution: approve `"@ethereumjs/common": "^10.1.2"` as a direct dependency of @webevm/devnode (and add it to ADR 0017's dependency list), then re-run the task unchanged. Minor bookkeeping: the runner said the task is at work/tasks/ready/, but it is actually at work/tasks/backlog/devnode-eth-send-transaction-from-dev-accounts.md, and its spec is at work/specs/tasked/dev-node-package.md, not work/specs/ready/. The blocker (devnode-package-dev-accounts-funded-at-genesis) is done, and its code matches this task's assumptions.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
