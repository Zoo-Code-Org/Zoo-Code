/**
 * Test helper for the lone UTF-16 surrogate request-sanitization guarantee (#461).
 *
 * A regex over `JSON.stringify` output can never observe a raw lone surrogate: since
 * well-formed JSON.stringify (ES2019), serialization escapes the code unit as `\udXXX`
 * text, so `expect(JSON.stringify(body)).not.toMatch(LONE_SURROGATE)` always passes and
 * proves nothing. This helper walks the raw, unstringified value instead and fails when
 * any reachable string contains an unpaired UTF-16 surrogate code unit.
 *
 * Operates on strings, arrays, plain objects (including their keys), Maps, and Sets.
 * `String.prototype.isWellFormed` is intentionally not used: `src/tsconfig.json`
 * targets ES2022 and that method arrived later.
 */

const HIGH_SURROGATE_MIN = 0xd800
const HIGH_SURROGATE_MAX = 0xdbff
const LOW_SURROGATE_MIN = 0xdc00
const LOW_SURROGATE_MAX = 0xdfff

/**
 * Reports whether `text` contains a UTF-16 code unit in the surrogate range that is not
 * part of a high-then-low pair. Valid pairs are skipped untouched.
 */
function containsLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index)
		if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX) {
			const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
			// A high surrogate is paired only when a low surrogate follows immediately.
			if (next < LOW_SURROGATE_MIN || next > LOW_SURROGATE_MAX) {
				return true
			}
			// Skip the low surrogate of the valid pair.
			index++
		} else if (unit >= LOW_SURROGATE_MIN && unit <= LOW_SURROGATE_MAX) {
			// A low surrogate without a preceding high surrogate is unpaired.
			return true
		}
	}
	return false
}

function assertNoLoneSurrogates(value: unknown, path: string, seen: Set<object>): void {
	if (typeof value === "string") {
		if (containsLoneSurrogate(value)) {
			throw new Error(`Expected no lone UTF-16 surrogate at ${path}, got: ${JSON.stringify(value)}`)
		}
		return
	}

	if (Array.isArray(value) || value instanceof Set) {
		if (seen.has(value)) {
			return
		}
		seen.add(value)
		const elements = Array.isArray(value) ? value : Array.from(value)
		elements.forEach((element, index) => assertNoLoneSurrogates(element, `${path}[${index}]`, seen))
		return
	}

	if (value instanceof Map) {
		if (seen.has(value)) {
			return
		}
		seen.add(value)
		Array.from(value.entries()).forEach(([key, nested], index) => {
			assertNoLoneSurrogates(key, `${path}[[${index}]].key`, seen)
			assertNoLoneSurrogates(nested, `${path}[[${index}]].value`, seen)
		})
		return
	}

	if (value && typeof value === "object") {
		if (seen.has(value)) {
			return
		}
		seen.add(value)
		for (const [key, nested] of Object.entries(value)) {
			assertNoLoneSurrogates(key, `${path}.${key}:key`, seen)
			assertNoLoneSurrogates(nested, `${path}.${key}`, seen)
		}
	}
}

/**
 * Asserts that no string reachable in `value` contains an unpaired UTF-16 surrogate.
 * Throws with the path of the first offending string so the failing test names the field.
 */
export function expectNoLoneSurrogates(value: unknown): void {
	assertNoLoneSurrogates(value, "$", new Set())
}
