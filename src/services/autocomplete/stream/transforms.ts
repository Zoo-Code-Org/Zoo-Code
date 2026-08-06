/**
 * Stream transforms applied to raw model output. Each transform inspects the
 * accumulated output and the incoming chunk, and may:
 * - modify the chunk to emit (e.g. truncate at a stop token),
 * - signal the stream should stop (return null),
 * - pass the chunk through unchanged.
 *
 * Phase 2 ships the first four transforms in the documented order:
 * stopAtStopTokens → filterHallucinatedPathLine → stopAtSuffixRepetition → stopAtSimilarLine.
 * Phases 5–6 add stopAtLines → balanceBrackets → trimTrailingWhitespace.
 */

export interface TransformContext {
	readonly prefix: string
	readonly suffix: string
	readonly stopSequences: readonly string[]
	readonly maxLines: number
	/**
	 * True when the reply came from a chat model, whose answer is routinely
	 * wrapped in a markdown fence. On that path the fence delimits the code
	 * rather than ending it, and is unwrapped after the stream completes.
	 */
	readonly isChatReply?: boolean
}

export interface StreamTransform {
	readonly id: string
	/**
	 * Called for each chunk with the output accumulated so far.
	 * @returns the text to emit (possibly modified), or null to stop the stream.
	 */
	onChunk(accumulated: string, chunk: string, context: TransformContext): string | null
}

/**
 * Stops the stream as soon as any stop sequence appears in the accumulated output,
 * truncating to before the sequence.
 */
export const stopAtStopTokens: StreamTransform = {
	id: "stopAtStopTokens",
	onChunk(accumulated, chunk, context) {
		if (context.stopSequences.length === 0) {
			return chunk
		}

		const combined = accumulated + chunk

		for (const stop of context.stopSequences) {
			const index = combined.indexOf(stop)

			if (index !== -1) {
				if (index < accumulated.length) {
					// The stop token straddles the boundary: it started in the
					// accumulated text, so the chunk only completes it. Emit nothing
					// new — the accumulated partial is already out.
					return ""
				}

				const truncated = combined.slice(0, index)
				return truncated.slice(accumulated.length)
			}
		}

		return chunk
	},
}

/**
 * Drops a "Path: …" / "diff --git" hallucination line the model sometimes emits
 * at the start of a completion. Stops the stream so nothing after the hallucinated
 * header is rendered.
 */
export const filterHallucinatedPathLine: StreamTransform = {
	id: "filterHallucinatedPathLine",
	onChunk(accumulated, chunk) {
		const combined = accumulated + chunk
		const lines = combined.split("\n")

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]

			if (HALLUCINATED_PATH_REGEX.test(line)) {
				// Drop everything from this line onward.
				const kept = lines.slice(0, i).join("\n")
				return kept.slice(accumulated.length) || ""
			}
		}

		return chunk
	},
}

/**
 * Stops the stream once the output begins repeating the suffix. Detects the
 * longest tail of the accumulated output that is a prefix of the suffix, and
 * truncates the overlap once it exceeds a threshold.
 */
export const stopAtSuffixRepetition: StreamTransform = {
	id: "stopAtSuffixRepetition",
	onChunk(accumulated, chunk, context) {
		if (context.suffix.length === 0) {
			return chunk
		}

		const combined = accumulated + chunk
		const overlap = longestSuffixPrefix(combined, context.suffix)

		if (overlap >= MIN_SUFFIX_OVERLAP) {
			const truncated = combined.slice(0, combined.length - overlap)
			return truncated.slice(accumulated.length) || ""
		}

		return chunk
	},
}

/**
 * Stops the stream when a line in the output matches a line already present in
 * the prefix or suffix (the model is echoing surrounding code).
 */
export const stopAtSimilarLine: StreamTransform = {
	id: "stopAtSimilarLine",
	onChunk(accumulated, chunk, context) {
		const combined = accumulated + chunk
		const lines = combined.split("\n")

		if (lines.length <= 1) {
			return chunk
		}

		const surrounding = new Set([...splitLines(context.prefix), ...splitLines(context.suffix)])

		// Inspect the last complete line (ignore the trailing partial line).
		const lastComplete = lines.length >= 2 ? lines[lines.length - 2] : null

		if (lastComplete !== null && surrounding.has(lastComplete.trim())) {
			const kept = lines.slice(0, -2).join("\n")
			return kept.slice(accumulated.length) || ""
		}

		return chunk
	},
}

/**
 * Stops the stream at the first reasoning-block opener or markdown fence.
 *
 * Hybrid-reasoning models (LFM2.5, Qwen3, DeepSeek-R1) and instruction-tuned
 * models emit `<think>…</think>` blocks and ```-fenced code even when told not to.
 * Stop sequences catch these only when the opener arrives as a clean token
 * boundary; a chunk of `foo<think>` slips past. This inspects the accumulated
 * text, so boundary placement is irrelevant.
 *
 * Everything from the opener onward is discarded — a completion that has started
 * narrating is not recoverable, and rendering half of it as ghost text is worse
 * than rendering nothing.
 */
export const stopAtReasoningBlock: StreamTransform = {
	id: "stopAtReasoningBlock",
	onChunk(accumulated, chunk, context) {
		const combined = accumulated + chunk
		const index = combined.search(context.isChatReply ? REASONING_OPENER_NO_FENCE_REGEX : REASONING_OPENER_REGEX)

		if (index === -1) {
			return chunk
		}

		if (index < accumulated.length) {
			// The opener is already (partly) emitted; nothing further may pass.
			return ""
		}

		return combined.slice(accumulated.length, index)
	},
}

/**
 * Stops the stream at a line of prose.
 *
 * An instruct model that ignores the "code only" instruction typically breaks
 * into English on its own line ("This code calculates…", "Note that…"). A line
 * that has no code punctuation, starts with a capital letter and reads as a
 * sentence is treated as the end of the completion.
 *
 * Deliberately conservative: it only fires on a *complete* line, never on the
 * first line (which is legitimately a code continuation), and never inside a
 * string or comment continuation, so real code is not truncated.
 */
export const stopAtProseLine: StreamTransform = {
	id: "stopAtProseLine",
	onChunk(accumulated, chunk) {
		const combined = accumulated + chunk
		const lines = combined.split("\n")

		// Only inspect complete lines, and never the first (it continues the cursor line).
		for (let i = 1; i < lines.length - 1; i++) {
			if (isProseLine(lines[i])) {
				const kept = lines.slice(0, i).join("\n")

				if (kept.length <= accumulated.length) {
					return ""
				}

				return kept.slice(accumulated.length)
			}
		}

		return chunk
	},
}

/** Caps the completion at `context.maxLines` lines. */
export const stopAtLines: StreamTransform = {
	id: "stopAtLines",
	onChunk(accumulated, chunk, context) {
		if (context.maxLines <= 0) {
			return chunk
		}

		const combined = accumulated + chunk
		const lines = combined.split("\n")

		if (lines.length <= context.maxLines) {
			return chunk
		}

		const kept = lines.slice(0, context.maxLines).join("\n")

		if (kept.length <= accumulated.length) {
			return ""
		}

		return kept.slice(accumulated.length)
	},
}

/**
 * The transforms in the documented order.
 *
 * Order matters: reasoning/fence detection runs before the echo detectors so a
 * narrating completion is cut at the narration rather than at whichever echoed
 * line happens to appear first, and the line cap runs last so it applies to
 * whatever survived.
 */
/**
 * Stops a model that has fallen into a degenerate repetition loop.
 *
 * Small models under a greedy sampler get stuck emitting the same short token
 * run forever (`1616161616…`). The stop sequences never fire because the run
 * contains no stop token, and the line cap never fires because it is all one
 * line — so this is the only thing that ends such a stream.
 */
export const stopAtRepetitionLoop: StreamTransform = {
	id: "stopAtRepetitionLoop",
	onChunk(accumulated, chunk) {
		const combined = accumulated + chunk

		for (let unit = 1; unit <= REPETITION_MAX_UNIT; unit++) {
			const span = unit * REPETITION_MIN_REPEATS

			if (combined.length < span) {
				break
			}

			const candidate = combined.slice(-unit)

			// Three consecutive repeats of the same unit: ordinary code effectively
			// never does this, whereas a looping model does it indefinitely.
			if (candidate.repeat(REPETITION_MIN_REPEATS) === combined.slice(-span)) {
				// Keep one copy; drop the repeats that follow it.
				const cut = combined.length - span + unit

				return cut <= accumulated.length ? "" : combined.slice(accumulated.length, cut)
			}
		}

		return chunk
	},
}

export const DEFAULT_TRANSFORMS: readonly StreamTransform[] = [
	stopAtStopTokens,
	stopAtReasoningBlock,
	stopAtRepetitionLoop,
	filterHallucinatedPathLine,
	stopAtSuffixRepetition,
	stopAtSimilarLine,
	stopAtProseLine,
	stopAtLines,
]

/** Reasoning-block openers, their closers, and markdown fences. */
const REASONING_OPENER_REGEX =
	/<\/?(?:think|thinking|reasoning|reflection|analysis)\b[^>]*>|```|^\s*(?:Here'?s|Here is|This (?:code|function|snippet)|Note that|Explanation:)/im

/** As above, minus the fence: used for chat replies, where a fence wraps the code. */
const REASONING_OPENER_NO_FENCE_REGEX =
	/<\/?(?:think|thinking|reasoning|reflection|analysis)\b[^>]*>|^\s*(?:Here'?s|Here is|This (?:code|function|snippet)|Note that|Explanation:)/im

/** Characters that mark a line as code rather than prose. */
const CODE_PUNCTUATION = /[{}()[\];=<>+*/%&|!~^]|:\s*$|,\s*$|\.\w|=>|->|::/

function isProseLine(line: string): boolean {
	const trimmed = line.trim()

	if (trimmed.length === 0) {
		return false
	}

	// Comments are legitimate completion output.
	if (/^(\/\/|#|\*|\/\*|--|<!--)/.test(trimmed)) {
		return false
	}

	if (CODE_PUNCTUATION.test(trimmed)) {
		return false
	}

	// A sentence: starts with a capital, contains several words, ends like prose.
	const words = trimmed.split(/\s+/)

	return words.length >= 4 && /^[A-Z]/.test(trimmed) && /[.!?:]$/.test(trimmed)
}

const HALLUCINATED_PATH_REGEX = /^\s*(path|file|diff\s+--git|index\s+[0-9a-f]{7,}|---\s|\/\/\s*path|\/\*path)\b/i

const MIN_SUFFIX_OVERLAP = 8

/**
 * Tail inspected for a repetition loop, and the longest repeating unit.
 *
 * The unit must cover whole phrases, not just short token runs: models loop on
 * `"A" * primer_length` (19 chars) as readily as on `12537`. The window is three
 * units wide so a match means three consecutive repeats, which ordinary code
 * effectively never produces.
 */
const REPETITION_MAX_UNIT = 40
const REPETITION_MIN_REPEATS = 3

/** Returns the length of the longest suffix of `text` that is a prefix of `prefix`. */
function longestSuffixPrefix(text: string, prefix: string): number {
	const max = Math.min(text.length, prefix.length)

	for (let length = max; length >= MIN_SUFFIX_OVERLAP; length--) {
		if (text.endsWith(prefix.slice(0, length))) {
			return length
		}
	}

	return 0
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}
