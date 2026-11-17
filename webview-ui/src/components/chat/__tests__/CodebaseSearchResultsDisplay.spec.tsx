// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/CodebaseSearchResultsDisplay.spec.tsx

import { fireEvent, screen } from "@testing-library/react"

import i18next from "@src/i18n/setup"
import { renderTranslated } from "@src/i18n/__tests__/renderTranslated"

import CodebaseSearchResultsDisplay from "../CodebaseSearchResultsDisplay"

vi.mock("../CodebaseSearchResult", () => ({
	default: ({ filePath }: { filePath: string }) => <div data-testid="search-result">{filePath}</div>,
}))

const makeResult = (filePath: string) => ({ filePath, score: 0.9, startLine: 1, endLine: 5, codeChunk: "code" })

describe("CodebaseSearchResultsDisplay", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it.each([
		[[makeResult("src/a.ts")], "Found 1 result"],
		[[makeResult("src/a.ts"), makeResult("src/b.ts")], "Found 2 results"],
	])("renders a pluralized summary for %#", (results, expected) => {
		renderTranslated(<CodebaseSearchResultsDisplay results={results} />)

		expect(screen.getByText(expected)).toBeInTheDocument()
	})

	it("toggles the result list when the header is clicked", () => {
		renderTranslated(<CodebaseSearchResultsDisplay results={[makeResult("src/a.ts"), makeResult("src/b.ts")]} />)
		expect(screen.queryByTestId("search-result")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("Found 2 results"))
		expect(screen.getAllByTestId("search-result").map((el) => el.textContent)).toEqual(["src/a.ts", "src/b.ts"])

		fireEvent.click(screen.getByText("Found 2 results"))
		expect(screen.queryByTestId("search-result")).not.toBeInTheDocument()
	})

	it("follows a UI language change without remounting", async () => {
		const { setLanguage } = renderTranslated(<CodebaseSearchResultsDisplay results={[makeResult("src/a.ts")]} />)

		await setLanguage("es")

		expect(screen.getByText("Se encontró 1 resultado")).toBeInTheDocument()
	})
})
