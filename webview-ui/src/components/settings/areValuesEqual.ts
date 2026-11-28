/**
 * True when two values are the same, both nullish, or JSON-equal. JSON comparison ignores object properties that are
 * `undefined`, because the message channel from the host drops them.
 */
export const areValuesEqual = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
