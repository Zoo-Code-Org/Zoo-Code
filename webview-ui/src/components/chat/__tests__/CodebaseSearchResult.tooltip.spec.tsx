import { render } from "@/utils/test-utils"

import CodebaseSearchResult from "../CodebaseSearchResult"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// The double only answers the key; the recorded call keeps both arguments so the case can assert on
// the interpolation object the tooltip asks for. `_options` is unused by the double on purpose.
const { tSpy } = vi.hoisted(() => ({ tSpy: vi.fn((key: string, _options?: Record<string, unknown>) => key) }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => tSpy(key, options) }),
}))

describe("CodebaseSearchResult - the tooltip it asks the translator for", () => {
	it("asks for the result tooltip with the score rounded to three places", () => {
		render(
			<CodebaseSearchResult
				filePath="src/example.ts"
				score={0.9512}
				startLine={12}
				endLine={18}
				snippet="const example = true"
				language="typescript"
			/>,
		)

		expect(tSpy).toHaveBeenCalledWith("chat:codebaseSearch.resultTooltip", { score: "0.951" })
	})
})
