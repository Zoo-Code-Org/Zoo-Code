/**
 * Shared sanitizers for lone UTF-16 surrogate code units in outbound API request bodies.
 *
 * A task's history can contain a lone surrogate — e.g. left behind when some upstream step
 * slices a string through an astral-plane character (emoji, CJK extension, etc.). Such a code
 * unit cannot be encoded as UTF-8, and providers that validate the JSON body (DeepSeek returns
 * `400 Failed to parse the request body as JSON: ... lone leading surrogate in hex escape`;
 * the VS Code LM backend rejects likewise) refuse the entire request, permanently breaking the
 * task. These helpers replace lone surrogates with U+FFFD at the request boundary while leaving
 * valid surrogate pairs untouched.
 */
/**
 * Matches unpaired UTF-16 surrogate code units. Valid surrogate pairs are matched by the
 * lookahead/lookbehind and left untouched. The regex intentionally omits the `u` flag so it
 * operates on UTF-16 code units.
 */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/**
 * Replaces unpaired UTF-16 surrogate code units with the Unicode replacement character (U+FFFD).
 */
export function sanitizeSurrogates(text: string): string {
	if (!text) {
		return text
	}
	return text.replace(LONE_SURROGATE, "\uFFFD")
}
/**
 * Sanitizes a tool call / tool result identifier without losing its distinctness.
 *
 * Plain {@link sanitizeSurrogates} maps every lone surrogate to the same U+FFFD, so ids differing
 * only in that surrogate collapse into one; providers match results to calls by id, so the
 * collision misroutes distinct tool calls. Appending the original code unit keeps the mapping
 * injective, and being a pure function of the input it keeps a call and its result paired.
 */
export function sanitizeIdentifierSurrogates(identifier: string): string {
	// Escaping MUST precede encoding, or the encoding pass re-escapes its own markers.
	return identifier
		.replace(/\uFFFD/g, "\uFFFDFFFD")
		.replace(LONE_SURROGATE, (unit) => `\uFFFD${unit.charCodeAt(0).toString(16).toUpperCase()}`)
}
/** Non-global twin of {@link LONE_SURROGATE}; `test` on a `/g` regex is stateful via `lastIndex`. */
export const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE.source)
/**
 * Applies {@link sanitizeSurrogates} to every string nested in a tool-call argument object. The
 * backend rejects the whole request for a lone surrogate anywhere in the JSON payload, so a tool
 * argument carrying a sliced astral character fails the request just as message text would.
 *
 * LIMITATION: keys are sanitized with the same lossy mapping, so keys differing only in their lone
 * surrogate (`"a\uD800"`, `"a\uD801"`) both become `"a\uFFFD"` and the last value wins. This also
 * applies to tool schemas, where colliding property definitions collapse and `required` can end up
 * with duplicate entries. Accepted deliberately: the alternative is rewriting keys into a form no
 * schema reference would match, and a request that reaches the backend beats one rejected outright.
 */
export function sanitizeSurrogatesDeep(value: unknown, path = new Set<unknown>()): unknown {
	if (typeof value === "string") {
		return sanitizeSurrogates(value)
	}
	if (typeof value !== "object") {
		return value
	}
	if (value === null) {
		return value
	}
	if (path.has(value)) {
		throw new TypeError("Converting circular structure to JSON")
	}
	path.add(value)
	if (Array.isArray(value)) {
		const items = value.map((item) => sanitizeSurrogatesDeep(item, path))
		path.delete(value)
		return items
	}
	const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
		sanitizeSurrogates(key),
		sanitizeSurrogatesDeep(nested, path),
	])
	path.delete(value)
	return Object.fromEntries(entries)
}
