import { render } from "ink-testing-library"

import type { TUIMessage } from "../../types.js"
import { extractToolData } from "../../utils/tools.js"
import ChatHistoryItem from "../ChatHistoryItem.js"
import { resetNerdFontCache } from "../Icon.js"

describe("ChatHistoryItem parallel subtasks row", () => {
	beforeEach(() => {
		// Use fallback icons in tests so they render as visible characters
		process.env.ROOCODE_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.ROOCODE_NERD_FONT
		resetNerdFontCache()
	})

	it("shows the tool label and delegation icon instead of the generic fallback", () => {
		const payload = {
			tool: "parallelSubtasks",
			tasks: [{ label: "api", mode: "architect", message: "Map the REST surface" }],
		}
		const message: TUIMessage = {
			id: "1",
			role: "tool",
			content: JSON.stringify(payload),
			toolName: "parallelSubtasks",
			toolData: extractToolData(payload),
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)
		const output = lastFrame()

		expect(output).toContain("Parallel Subtasks")
		expect(output).not.toContain("⚙")
		expect(output).not.toContain("parallelSubtasks")
	})
})
