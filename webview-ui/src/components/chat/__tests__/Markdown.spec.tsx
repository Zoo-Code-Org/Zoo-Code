import { renderWithExtensionState } from "@/utils/test-utils"

import MarkdownBlock from "../../common/MarkdownBlock"
import { Markdown } from "../Markdown"

vi.mock("../../common/MarkdownBlock", () => ({
	default: vi.fn(() => null),
}))

describe("Markdown table striping", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([
		{ tableStriped: true, expectedStriped: true },
		{ tableStriped: false, expectedStriped: false },
		{ tableStriped: undefined, expectedStriped: false },
	])(
		"passes striped=$expectedStriped when extension state tableStriped=$tableStriped",
		({ tableStriped, expectedStriped }) => {
			const markdown = "| Name | Value |\n| --- | --- |\n| Setting | Saved |"
			renderWithExtensionState(<Markdown markdown={markdown} />, { state: { tableStriped } })

			expect(vi.mocked(MarkdownBlock).mock.lastCall?.[0]).toMatchObject({ markdown, striped: expectedStriped })
		},
	)
})
