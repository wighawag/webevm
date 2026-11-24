/**
 * revm-outcome-format.ts: a copy of the revm `.wasm` that REPORTS AN OLDER
 * OUTCOME FORMAT, for the one case a consumer can reach and this repo cannot
 * install: `createRevmEngine({wasm})` given an artifact older than outcome
 * format 5 (their own build, or an older release's bytes), on a console-logging
 * node, which must be refused at construction (ADR 0018).
 *
 * WHY A PATCH, NOT A SECOND PACKAGE: the only alternative is a second, aliased
 * `revm-wasm` dependency pinned at an older release, for one assertion. The
 * patch changes exactly what the engine reads, the constant
 * `revm_wasm_outcome_format_version()` returns, and nothing else: the function
 * body is `i32.const <format>; end` with no locals, and the patch REFUSES to
 * touch anything else, so a future artifact that computes the version some
 * other way fails this helper loudly rather than patching the wrong byte.
 */

const EXPORT_NAME = 'revm_wasm_outcome_format_version';

/** `bytes` with `revm_wasm_outcome_format_version()` returning `format` (0..63). */
export function withOutcomeFormat(
	bytes: Uint8Array,
	format: number,
): Uint8Array {
	if (!Number.isInteger(format) || format < 0 || format > 63)
		throw new Error(`withOutcomeFormat: ${format} is not a one-byte i32.const`);
	const b = new Uint8Array(bytes);
	let p = 8; // magic + version
	const leb = (): number => {
		let result = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = b[p++];
			result |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return result >>> 0;
	};
	const skipName = () => {
		const n = leb();
		p += n;
	};
	const readName = () => {
		const n = leb();
		const name = new TextDecoder().decode(b.subarray(p, p + n));
		p += n;
		return name;
	};
	const skipLimits = () => {
		const flags = b[p++];
		leb();
		if (flags & 1) leb();
	};

	let importedFunctions = 0;
	let functionIndex: number | undefined;
	while (p < b.length) {
		const id = b[p++];
		const size = leb();
		const end = p + size;
		if (id === 2) {
			// imports: count the imported functions, which precede the defined ones
			const n = leb();
			for (let i = 0; i < n; i++) {
				skipName();
				skipName();
				const kind = b[p++];
				if (kind === 0) {
					leb();
					importedFunctions++;
				} else if (kind === 1) {
					p++; // reftype
					skipLimits();
				} else if (kind === 2) skipLimits();
				else if (kind === 3)
					p += 2; // valtype + mutability
				else if (kind === 4) {
					p++;
					leb();
				} else
					throw new Error(`withOutcomeFormat: unknown import kind ${kind}`);
			}
		} else if (id === 7) {
			const n = leb();
			for (let i = 0; i < n; i++) {
				const name = readName();
				const kind = b[p++];
				const index = leb();
				if (name === EXPORT_NAME && kind === 0) functionIndex = index;
			}
		} else if (id === 10) {
			if (functionIndex === undefined)
				throw new Error(`withOutcomeFormat: no exported ${EXPORT_NAME}`);
			const target = functionIndex - importedFunctions;
			const n = leb();
			for (let i = 0; i < n; i++) {
				const bodySize = leb();
				if (i === target) {
					// `00` no locals, `41 nn` i32.const nn, `0b` end
					if (
						bodySize !== 4 ||
						b[p] !== 0x00 ||
						b[p + 1] !== 0x41 ||
						b[p + 3] !== 0x0b
					)
						throw new Error(
							`withOutcomeFormat: ${EXPORT_NAME} is not a constant; refusing to patch`,
						);
					b[p + 2] = format;
					return b;
				}
				p += bodySize;
			}
		}
		p = end;
	}
	throw new Error(`withOutcomeFormat: ${EXPORT_NAME} has no body`);
}
