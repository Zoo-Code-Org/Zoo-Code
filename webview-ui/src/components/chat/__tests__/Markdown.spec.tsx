import React from "react"
import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import { Markdown } from "../Markdown"

const mockMarkdownBlock = vi.fn()

vi.mock("@src/components/common/MarkdownBlock", () => ({
	default: (props: { markdown?: string; striped?: boolean }) => {
		mockMarkdownBlock(props)
		return <div data-testid="markdown-block">{props.markdown}</div>
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

describe("Markdown", () => {
	beforeEach(() => {
		mockMarkdownBlock.mockClear()
	})

	it("renders null when no markdown is provided", () => {
		const { container } = renderWithExtensionState(<Markdown markdown={undefined} />)
		expect(container.firstChild).toBeNull()
	})

	it("passes the tableStriped setting down to MarkdownBlock", () => {
		renderWithExtensionState(<Markdown markdown="hello" />, {
			state: { tableStriped: true } as never,
		})
		expect(screen.getByText("hello")).toBeInTheDocument()
		expect(mockMarkdownBlock).toHaveBeenCalledWith(expect.objectContaining({ striped: true }))
	})

	it("defaults striped to false when tableStriped is unset", () => {
		renderWithExtensionState(<Markdown markdown="hello" />)
		expect(mockMarkdownBlock).toHaveBeenCalledWith(expect.objectContaining({ striped: false }))
	})

	it("shows the copy button on hover", () => {
		renderWithExtensionState(<Markdown markdown="hello" />)
		const container = screen.getByText("hello").closest("div") as HTMLElement
		fireEvent.mouseEnter(container)

		expect(screen.getByRole("button")).toBeTruthy()
	})
})
