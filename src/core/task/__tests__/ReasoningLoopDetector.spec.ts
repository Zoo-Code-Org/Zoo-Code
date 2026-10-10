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

	it("does not flag repeated short phrases or ordinary long reasoning", () => {
		const detector = new ReasoningLoopDetector()
		const reasoning = Array.from(
			{ length: 40 },
			(_, index) =>
				`Step ${index}: inspect file ${index}, compare its behavior, and record the distinct result. OK.\n`,
		).join("")

		expect(detector.add(reasoning)).toBe(false)
	})
})
