import { mentionSegmentSchema, type MentionSegment } from "@roo-code/types"

const segmentsSchema = mentionSegmentSchema.array()

export const joinSegments = (segments: MentionSegment[]): string => segments.map((s) => s.text).join("")

/** The text that may have mentions expanded, one user part per line. */
export const userText = (segments: MentionSegment[]): string =>
	segments
		.filter((s) => s.source === "user")
		.map((s) => s.text)
		.join("\n")

export const userSegments = (text: string): MentionSegment[] => (text ? [{ text, source: "user" }] : [])

export const generatedSegments = (text: string): MentionSegment[] => (text ? [{ text, source: "generated" }] : [])

/** Drops empty parts and joins neighbors that have the same source. */
const merge = (segments: MentionSegment[]): MentionSegment[] => {
	const result: MentionSegment[] = []
	for (const segment of segments) {
		if (!segment.text) continue
		const last = result[result.length - 1]
		if (last?.source === segment.source) {
			last.text += segment.text
		} else {
			result.push({ ...segment })
		}
	}
	return result
}

/**
 * Checks segments that arrive from outside. Fails closed: anything that is
 * not a valid list whose text matches `text` becomes all generated.
 */
export const normalizeSegments = (text: string, segments: unknown): MentionSegment[] => {
	const parsed = segmentsSchema.safeParse(segments)
	return parsed.success && joinSegments(parsed.data) === text ? merge(parsed.data) : generatedSegments(text)
}

export const trimSegments = (segments: MentionSegment[]): MentionSegment[] => {
	const result = merge(segments)
	while (result.length > 0) {
		const first = result[0]!
		first.text = first.text.trimStart()
		if (first.text) break
		result.shift()
	}
	while (result.length > 0) {
		const last = result[result.length - 1]!
		last.text = last.text.trimEnd()
		if (last.text) break
		result.pop()
	}
	return result
}

const slice = (segments: MentionSegment[], start: number, end: number): MentionSegment[] => {
	const result: MentionSegment[] = []
	let offset = 0
	for (const segment of segments) {
		const from = Math.max(start - offset, 0)
		const to = Math.min(end - offset, segment.text.length)
		if (from < to) result.push({ text: segment.text.slice(from, to), source: segment.source })
		offset += segment.text.length
	}
	return result
}

/**
 * Records a manual edit. The changed range is the part between the common
 * prefix and the common suffix. The new text there is `user`. The rest keeps
 * its source. If the segments do not match `oldValue`, the result is all
 * generated.
 */
export const applyEdit = (segments: MentionSegment[], oldValue: string, newValue: string): MentionSegment[] => {
	if (joinSegments(segments) !== oldValue) return generatedSegments(newValue)

	const max = Math.min(oldValue.length, newValue.length)
	let prefix = 0
	while (prefix < max && oldValue[prefix] === newValue[prefix]) prefix++
	let suffix = 0
	while (suffix < max - prefix && oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]) {
		suffix++
	}

	return merge([
		...slice(segments, 0, prefix),
		...userSegments(newValue.slice(prefix, newValue.length - suffix)),
		...slice(segments, oldValue.length - suffix, oldValue.length),
	])
}
