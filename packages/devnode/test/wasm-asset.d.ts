/**
 * The BUNDLER-RESOLVED revm wasm, for TypeScript (as in packages/webevm). The
 * spec aliases `revm-wasm/revm.wasm` to the copy webevm itself depends on and
 * esbuild loads it as `binary`, so the bytes are in the bundle.
 */
declare module 'revm-wasm/revm.wasm' {
	const bytes: Uint8Array<ArrayBuffer>;
	export default bytes;
}
