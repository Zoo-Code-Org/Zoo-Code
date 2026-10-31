import { ReasoningLoopDetector } from "../ReasoningLoopDetector"

describe("ReasoningLoopDetector", () => {
	it("detects the reported reasoning loop across arbitrary stream chunks", () => {
		const detector = new ReasoningLoopDetector()
		const cycle = "OK.\n\nHmm. Let me read them.\n\nOK.\n\nHmm. Let me just do it.\n\nLet me read the files.\n\n"
		const output = `I will inspect the implementation first.\n${cycle.repeat(8)}`
		let detected = false

		for (let offset = 0; offset < output.length; offset += 17) {
			detected ||= detector.add(output.slice(offset, offset + 17))
		}

		expect(detected).toBe(true)
	})

	it("does not flag ordinary long reasoning made of distinct lines", () => {
		const detector = new ReasoningLoopDetector()
		const reasoning = Array.from(
			{ length: 40 },
			(_, index) =>
				`Step ${index}: inspect file ${index}, compare its behavior, and record the distinct result. OK.\n`,
		).join("")

		expect(detector.add(reasoning)).toBe(false)
	})

	it("does not flag a short phrase repeated a few times", () => {
		const detector = new ReasoningLoopDetector()

		expect(detector.add("Let me read the files.\n".repeat(10))).toBe(false)
	})

	// A cycle of `length` characters that is not periodic itself, so only its own length can match.
	const cycleOf = (length: number) =>
		Array.from({ length: 200 }, (_, index) => `w${index} `)
			.join("")
			.slice(0, length)

	// MIN_PATTERN_LENGTH is 80 and REQUIRED_REPETITIONS is 5.
	it.each([
		{ length: 80, repetitions: 5, flagged: true },
		{ length: 80, repetitions: 4, flagged: false },
		{ length: 81, repetitions: 5, flagged: true },
		{ length: 81, repetitions: 4, flagged: false },
		{ length: 79, repetitions: 5, flagged: false },
		// 9 repeats hold only 4.5 copies of the doubled 158-character cycle, which is still below the threshold.
		{ length: 79, repetitions: 9, flagged: false },
		// 10 repeats are 5 copies of the doubled cycle, so a short cycle is still caught once it persists.
		{ length: 79, repetitions: 10, flagged: true },
	])("flags a $length-character cycle repeated $repetitions times: $flagged", ({ length, repetitions, flagged }) => {
		const detector = new ReasoningLoopDetector()

		expect(detector.add(cycleOf(length).repeat(repetitions))).toBe(flagged)
	})
})
