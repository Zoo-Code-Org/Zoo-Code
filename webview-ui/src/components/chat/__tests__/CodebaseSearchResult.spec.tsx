import { fireEvent, render, screen } from "@/utils/test-utils"
import { beforeEach, describe, expect, test, vi } from "vitest"

import CodebaseSearchResult from "../CodebaseSearchResult"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

describe("CodebaseSearchResult", () => {
	beforeEach(() => vi.clearAllMocks())

	test("opens the selected file at the result start line", () => {
		render(
			<CodebaseSearchResult
				filePath="src/example.ts"
				score={0.95}
				startLine={12}
				endLine={18}
				snippet="const example = true"
				language="typescript"
			/>,
		)

		const fileName = screen.getByText("example.ts:12-18")
		expect(fileName).toHaveClass("group-hover:text-vscode-list-hoverForeground")
		expect(screen.getByText("src")).toHaveClass("group-hover:text-vscode-list-hoverForeground")
		fireEvent.click(fileName)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "./src/example.ts",
			values: { line: 12 },
		})
	})
})
