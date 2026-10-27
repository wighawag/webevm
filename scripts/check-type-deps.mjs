#!/usr/bin/env node
// Fails if a published declaration file imports a package that the package does not declare in
// `dependencies`, `peerDependencies` or `optionalDependencies`.
//
// Why: a package whose .d.ts imports, say, `eip-1193` but lists it only in devDependencies
// type-checks in its own repo and then, for consumers, resolves against whatever copy pnpm
// happens to hoist. That is how eip-1193 0.7 arriving through one dependency broke apps whose
// other dependencies were written against 0.6. A devDependency is invisible to consumers, so a
// type import needs a real dependency (or a peer).
//
// Usage: node scripts/check-type-deps.mjs [packageDir ...]
// With no argument it checks the current directory. Run it AFTER the build: it reads the
// declaration files the build emitted, which are what gets published.
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {builtinModules} from 'node:module';

const builtins = new Set(builtinModules);

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules') continue;
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) walk(full, out);
		else if (/\.d\.(c|m)?ts$/.test(entry)) out.push(full);
	}
	return out;
}

function packageNameOf(specifier) {
	if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/.test(specifier)) return undefined;
	if (specifier.startsWith('node:')) return undefined;
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	if (builtins.has(name)) return undefined;
	return name;
}

// Matches `from '<x>'`, `import '<x>'`, `import('<x>')` and `require('<x>')` in declaration files.
// Declaration files are small, line-based and never minified, so a simple bounded regex is fine.
const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]{1,200})['"]/g;

let failures = 0;
const dirs = process.argv.slice(2);
for (const dir of dirs.length ? dirs : ['.']) {
	const pkgDir = resolve(dir);
	const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
	if (pkg.private) continue;
	const declared = new Set([
		pkg.name,
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
		...Object.keys(pkg.optionalDependencies ?? {}),
	]);
	const roots = (pkg.files ?? ['dist']).map((f) => join(pkgDir, f)).filter((p) => existsSync(p));
	const files = [];
	for (const root of roots) {
		if (statSync(root).isDirectory()) walk(root, files);
		else if (/\.d\.(c|m)?ts$/.test(root)) files.push(root);
	}
	if (files.length === 0) {
		// A package that publishes no types (a prebuilt bundle, say) has nothing to check. One that
		// points at declaration files but has none on disk has not been built yet.
		const promisesTypes = /\.d\.(c|m)?ts/.test(JSON.stringify([pkg.types, pkg.typings, pkg.exports]));
		if (promisesTypes) {
			console.error(`${pkg.name}: no declaration files found, build first`);
			failures++;
		} else {
			console.log(`${pkg.name}: publishes no declaration files, skipped`);
		}
		continue;
	}
	const missing = new Map();
	for (const file of files) {
		// Comments can quote import statements (examples in TSDoc), so drop them first.
		const content = readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		for (const match of content.matchAll(importPattern)) {
			const name = packageNameOf(match[1]);
			if (name && !declared.has(name) && !declared.has(`@types/${name}`)) {
				if (!missing.has(name)) missing.set(name, file);
			}
		}
	}
	for (const [name, file] of missing) {
		console.error(
			`${pkg.name}: ${file.slice(pkgDir.length + 1)} imports '${name}', which is not in dependencies or peerDependencies`,
		);
		failures++;
	}
	if (missing.size === 0)
		console.log(`${pkg.name}: every package its declarations import is declared (${files.length} files)`);
}
process.exit(failures ? 1 : 0);
