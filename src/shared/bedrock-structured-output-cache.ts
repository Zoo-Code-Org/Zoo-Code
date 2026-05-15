/**
 * Pure helpers for the hidden "Bedrock models observed to reject strict structured output" cache.
 *
 * The cache lives under the `bedrockStructuredOutputUnsupported` key in global state, shaped as
 * `Record<modelId, expiryEpochMs>`. This file owns the read/write logic so both the Task layer
 * (which holds the ContextProxy) and unit tests can exercise it without a VS Code dependency.
 *
 * Expiry is 30 days from the moment a rejection is observed. Expired entries are purged lazily on
 * the next `markUnsupported` write so a model that's been re-enabled in Bedrock gets re-probed.
 */

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type StructuredOutputUnsupportedMap = Record<string, number>

export function isUnsupported(
	map: StructuredOutputUnsupportedMap | undefined,
	modelId: string,
	now: number = Date.now(),
): boolean {
	if (!map) return false
	const expiry = map[modelId]
	return typeof expiry === "number" && expiry > now
}

export function markUnsupported(
	map: StructuredOutputUnsupportedMap | undefined,
	modelId: string,
	now: number = Date.now(),
): StructuredOutputUnsupportedMap {
	const next: StructuredOutputUnsupportedMap = {}
	if (map) {
		for (const [id, expiry] of Object.entries(map)) {
			if (typeof expiry === "number" && expiry > now) {
				next[id] = expiry
			}
		}
	}
	next[modelId] = now + THIRTY_DAYS_MS
	return next
}
