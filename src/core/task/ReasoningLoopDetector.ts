const MIN_PATTERN_LENGTH = 80
const MAX_PATTERN_LENGTH = 2_048
const REQUIRED_REPETITIONS = 5
const CHECK_INTERVAL = 64
const BUFFER_LENGTH = MAX_PATTERN_LENGTH * (REQUIRED_REPETITIONS + 1)

/** Detects sustained, exact repetition in streamed model reasoning. */
export class ReasoningLoopDetector {
	private buffer = ""
	private uncheckedCharacters = 0

	add(text: string): boolean {
		if (!text) {
			return false
		}

		this.buffer = (this.buffer + text).slice(-BUFFER_LENGTH)
		this.uncheckedCharacters += text.length

		if (this.uncheckedCharacters < CHECK_INTERVAL) {
			return false
		}
		this.uncheckedCharacters = 0

		const maxPatternLength = Math.min(MAX_PATTERN_LENGTH, Math.floor(this.buffer.length / REQUIRED_REPETITIONS))
		for (let patternLength = MIN_PATTERN_LENGTH; patternLength <= maxPatternLength; patternLength++) {
			const patternStart = this.buffer.length - patternLength
			const pattern = this.buffer.slice(patternStart)
			let repeats = true

			for (let repetition = 2; repetition <= REQUIRED_REPETITIONS; repetition++) {
				const start = this.buffer.length - patternLength * repetition
				if (this.buffer.slice(start, start + patternLength) !== pattern) {
					repeats = false
					break
				}
			}

			if (repeats) {
				return true
			}
		}

		return false
	}
}

export class RepetitiveReasoningError extends Error {
	constructor() {
		super(
			"Repetitive reasoning detected. The model appears to be stuck in a loop, so Zoo Code stopped the request. Retry with less context or a different model.",
		)
		this.name = "RepetitiveReasoningError"
		Object.setPrototypeOf(this, RepetitiveReasoningError.prototype)
	}
}
