import { createHash } from "node:crypto"

// Canonical JSON for digests. Object keys are sorted, array order is kept, and
// the output is stable across processes. Any content change changes the digest,
// so a digest pins content, not formatting.
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, sortValue(entry)]),
		)
	}
	return value
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

export function digestValue(value: unknown): string {
	return sha256Hex(canonicalJson(value))
}
