#!/usr/bin/env bash
# Shows how changesets bumps @webevm/devnode (which takes webevm as a PEER
# dependency) when webevm is released, with and without
# ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange.
#
# Everything happens in throwaway clones under the system temp directory: the
# working checkout is never touched, nothing is committed back, nothing is
# published. Run it again after any upgrade of @changesets/cli.
#
# Usage: docs/spikes/a-webevm-release-does-not-major-bump-devnode/check-peer-bump.sh [repo-path]
set -euo pipefail

src=$(cd "${1:-$(git rev-parse --show-toplevel)}" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One install, shared by both runs.
git clone -q "$src" "$work/deps"
(cd "$work/deps" && timeout 300 pnpm install --frozen-lockfile --ignore-scripts >/dev/null)
cs="$work/deps/node_modules/.bin/changeset"
"$cs" --version

status() {
	# Drop changesets' noisy "must depend on the current version" warning for
	# the >=0.10.0 peer while webevm is still 0.9.1.
	"$cs" status --verbose 2>&1 | grep -v 'must depend on the current version' | head -40
}

run() { # $1 = with | without
	local r="$work/$1"
	git clone -q "$src" "$r"
	cd "$r"
	git checkout -q -B main # changeset status diffs against baseBranch "main"
	ln -s "$work/deps/node_modules" node_modules
	# Use the working checkout's config (uncommitted edits included).
	cp "$src/.changeset/config.json" .changeset/config.json
	if [ "$1" = without ]; then
		node -e 'const f=".changeset/config.json";const c=JSON.parse(require("fs").readFileSync(f,"utf8"));delete c.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH;require("fs").writeFileSync(f,JSON.stringify(c,null,2))'
	fi
	git -c user.email=x@x -c user.name=x commit -qam cfg --allow-empty
	echo "== changeset status (pending release)"
	status
	"$cs" version >/dev/null 2>&1
	echo "== versions after changeset version (webevm, @webevm/devnode)"
	grep -h '"version"' packages/webevm/package.json packages/devnode/package.json
	git -c user.email=x@x -c user.name=x commit -qam version
	printf -- '---\n"webevm": minor\n---\n\nnext\n' >.changeset/next.md
	echo "== changeset status after adding a webevm: minor changeset"
	status
	printf -- '---\n"webevm": major\n---\n\nnext\n' >.changeset/next.md
	echo "== changeset status after adding a webevm: major changeset"
	status
	cd "$src"
}

echo "########## WITHOUT onlyUpdatePeerDependentsWhenOutOfRange"
run without
echo "########## WITH onlyUpdatePeerDependentsWhenOutOfRange"
run with
