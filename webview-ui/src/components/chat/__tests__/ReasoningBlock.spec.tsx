import React from "react"
import { render, screen } from "@testing-library/react"

import { ReasoningBlock } from "../ReasoningBlock"

// Keep the markdown renderer out of the way; this suite focuses on the
// "Thinking..." label and its shimmer state.
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
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

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		reasoningBlockCollapsed: false,
	}),
}))

const renderReasoningBlock = (props: Partial<React.ComponentProps<typeof ReasoningBlock>> = {}) => {
	return render(
		<ReasoningBlock content="some reasoning content" ts={123} isStreaming={false} isLast={false} {...props} />,
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
