import { markdownFormattingSection } from "../markdown-formatting"

describe("markdownFormattingSection", () => {
	it("references attempt_completion only when it is available", () => {
		const withCompletion = markdownFormattingSection({
			availableToolNames: new Set(["attempt_completion"]),
		})
		const withoutCompletion = markdownFormattingSection({ availableToolNames: new Set() })

		expect(withCompletion).toContain("and ALSO those in attempt_completion")
		expect(withoutCompletion).not.toContain("attempt_completion")
	})
})
