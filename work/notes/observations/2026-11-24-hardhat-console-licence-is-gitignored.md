---
title: The vendored Hardhat console.sol licence file is gitignored, so it was never committed
date: 2026-11-24
status: open
---

Found at the conductor's Gate-3 review of `webevm-console-log-decodes-and-formats-console-calls` (commit 65d2cd0). `packages/webevm/test/fixtures/README.md` says the Hardhat fixture's licence is kept at `console-log/hardhat/LICENSE`, but that file is not in the tree: `packages/webevm/.gitignore` line 8 ignores `LICENSE` (there for the package's own build-time copy of the root licence), so the build agent's copy was silently dropped (`git check-ignore -v packages/webevm/test/fixtures/console-log/hardhat/LICENSE` names that rule). The forge-std licences survived only because they are named `LICENSE-MIT` / `LICENSE-APACHE`. The vendored `console.sol` keeps only its `SPDX-License-Identifier: MIT` line, not the MIT copyright notice, so the task's "licences kept" criterion is not fully met. Fix: anchor the ignore rule (`/LICENSE`) or add a negation for `test/fixtures/**/LICENSE`, then commit Hardhat's `packages/hardhat/LICENSE` at `hardhat@3.22.0`. Small, mechanical, not blocking the console-log feature.
