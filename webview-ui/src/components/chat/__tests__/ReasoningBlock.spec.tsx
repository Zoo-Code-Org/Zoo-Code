import React from "react"
import { renderWithExtensionState, screen } from "@/utils/test-utils"

import MarkdownBlock from "../../common/MarkdownBlock"
import { ReasoningBlock } from "../ReasoningBlock"

// Isolate the label behavior and the props passed to the markdown renderer.
vi.mock("../../common/MarkdownBlock", () => ({
	default: vi.fn(({ markdown }: { markdown: string; striped?: boolean }) => (
		<div data-testid="markdown">{markdown}</div>
	)),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) => {
			if (key === "chat:reasoning.thinking") {
				return "Thinking..."
			}
			if (key === "chat:reasoning.seconds" && options?.count !== undefined) {
				return `${options.count}s`
			}
			return key
		},
	}),
}))

const renderReasoningBlock = (props: Partial<React.ComponentProps<typeof ReasoningBlock>> = {}) => {
	return renderWithExtensionState(
		<ReasoningBlock content="some reasoning content" ts={123} isStreaming={false} isLast={false} {...props} />,
		{ state: { reasoningBlockCollapsed: false } },
	)
}

describe("ReasoningBlock thinking shimmer", () => {
	it("applies the shimmer animation to the latest streaming block", () => {
		renderReasoningBlock({ isStreaming: true, isLast: true })

		const label = screen.getByText("Thinking...")
		expect(label).toHaveClass("animate-thinking-shine")
		expect(label).not.toHaveClass("text-vscode-foreground")
	})

	it("keeps historical reasoning blocks static while another block is streaming", () => {
		renderReasoningBlock({ isStreaming: true, isLast: false })

		const label = screen.getByText("Thinking...")
		expect(label).not.toHaveClass("animate-thinking-shine")
		expect(label).toHaveClass("text-vscode-foreground")
	})

	it("keeps completed reasoning blocks static once streaming has finished", () => {
		renderReasoningBlock({ isStreaming: false, isLast: true })

		const label = screen.getByText("Thinking...")
		expect(label).not.toHaveClass("animate-thinking-shine")
		expect(label).toHaveClass("text-vscode-foreground")
	})

	it("always keeps the bold styling on the thinking label", () => {
		renderReasoningBlock({ isStreaming: true, isLast: true })

		expect(screen.getByText("Thinking...")).toHaveClass("font-bold")
	})
})

describe("ReasoningBlock table striping", () => {
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
			const content = "| Name | Value |\n| --- | --- |\n| Setting | Saved |"
			renderWithExtensionState(<ReasoningBlock content={content} ts={123} isStreaming={false} isLast={false} />, {
				state: { reasoningBlockCollapsed: false, tableStriped },
			})

			expect(vi.mocked(MarkdownBlock).mock.lastCall?.[0]).toMatchObject({
				markdown: content,
				striped: expectedStriped,
			})
		},
	)
})
