import React from "react"
import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@roo-code/types"
import { ChatRowContent } from "../ChatRow"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
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

// Mock CodeBlock (avoid ESM/highlighter costs)
vi.mock("@src/components/common/CodeBlock", () => ({
	default: () => null,
}))

// Mock useSelectedModel so the hook has a stable default
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const makeUserFeedback = (): ClineMessage =>
	({ ts: 1, type: "say", say: "user_feedback", text: "hello bubble" }) as ClineMessage

function renderRow(message: ClineMessage, isExpanded = false, isStreaming = false) {
	return renderWithExtensionState(
		<ChatRowContent
			message={message}
			isExpanded={isExpanded}
			isLast={false}
			isStreaming={isStreaming}
			onToggleExpand={() => {}}
			onSuggestionClick={() => {}}
			onBatchFileResponse={() => {}}
			onFollowUpUnmount={() => {}}
			isFollowUpAnswered={false}
		/>,
	)
}

describe("ChatRow - user feedback bubble layout & contrast", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockPostMessage.mockClear()
	})

	it("lays the user feedback row out as a right-aligned bubble", () => {
		const { container } = renderRow(makeUserFeedback())

		// The wrapper is the bubble container
		const bubbleContainer = container.querySelector(".ml-auto") as HTMLElement | null
		expect(bubbleContainer).toBeTruthy()
		expect(bubbleContainer!.className).toContain("w-fit")
		expect(bubbleContainer!.className).toContain("max-w-[70%]")
		expect(bubbleContainer!.className).toContain("items-end")
		expect(bubbleContainer!.className).toContain("flex-col")
	})

	it("uses a soft themed background instead of the inverted foreground color", () => {
		const { container } = renderRow(makeUserFeedback())
		const bubble = container.querySelector(".cursor-text") as HTMLElement | null

		expect(bubble).toBeTruthy()
		expect(bubble!.className).toContain("bg-vscode-list-hoverBackground")
		expect(bubble!.className).toContain("text-vscode-foreground")
		// The previous implementation inverted foreground/background, causing harsh contrast.
		expect(bubble!.className).not.toContain("bg-vscode-editor-foreground/70")
		expect(bubble!.className).not.toContain("text-vscode-editor-background")
	})

	it("still renders the message text", () => {
		const { container } = renderRow(makeUserFeedback())
		const bubble = container.querySelector(".cursor-text") as HTMLElement | null

		expect(bubble).toBeTruthy()
		expect(bubble!.textContent).toContain("hello bubble")
	})

	it("places edit/delete action buttons outside the bubble", () => {
		const { container } = renderRow(makeUserFeedback())

		// The action buttons container is a sibling of the bubble, below it
		const actionBar = Array.from(container.querySelectorAll("div")).find(
			(el) => el.className.includes("flex") && el.className.includes("gap-2") && el.className.includes("pr-1"),
		) as HTMLElement | undefined

		expect(actionBar).toBeTruthy()
		expect(actionBar!.querySelector('[aria-label="Edit message icon"]')).toBeTruthy()
		expect(actionBar!.querySelector('[aria-label="Delete message icon"]')).toBeTruthy()

		// The bubble must NOT contain the edit/delete icons
		const bubble = container.querySelector(".cursor-text") as HTMLElement | null
		expect(bubble).toBeTruthy()
		expect(bubble!.querySelector('[aria-label="Edit message icon"]')).toBeFalsy()
		expect(bubble!.querySelector('[aria-label="Delete message icon"]')).toBeFalsy()
	})

	it("stays out of edit mode and hides edit/delete actions while streaming", () => {
		const { container } = renderRow(makeUserFeedback(), false, true)

		// Clicking the bubble must not enter edit mode while streaming.
		const clickTarget = container.querySelector('[title="chat:queuedMessages.clickToEdit"]') as HTMLElement | null
		expect(clickTarget).toBeTruthy()
		fireEvent.click(clickTarget!)

		// The bubble keeps its resting (non-edit) treatment instead of switching to
		// the editor background used in edit mode.
		const bubbleWrapper = container.querySelector(".border.rounded-sm") as HTMLElement | null
		expect(bubbleWrapper).toBeTruthy()
		expect(bubbleWrapper!.className).toContain("cursor-text")
		expect(bubbleWrapper!.className).toContain("bg-vscode-list-hoverBackground")
		expect(bubbleWrapper!.className).not.toContain("bg-vscode-editor-background")

		// The edit/delete action icons remain mounted but hidden via visibility: hidden.
		const actionBar = Array.from(container.querySelectorAll("div")).find(
			(el) => el.className.includes("flex") && el.className.includes("gap-2") && el.className.includes("pr-1"),
		) as HTMLElement | undefined
		expect(actionBar).toBeTruthy()

		const editIconWrapper = actionBar!.querySelector('[aria-label="Edit message icon"]')
			?.parentElement as HTMLElement | null
		const deleteIconWrapper = actionBar!.querySelector('[aria-label="Delete message icon"]')
			?.parentElement as HTMLElement | null
		expect(editIconWrapper).toBeTruthy()
		expect(deleteIconWrapper).toBeTruthy()
		expect(editIconWrapper!.style.visibility).toBe("hidden")
		expect(deleteIconWrapper!.style.visibility).toBe("hidden")
	})

	it("uses the editor background for the bubble while editing", () => {
		const { container } = renderRow(makeUserFeedback())

		// Enter edit mode by clicking the message text (the clickable inner bubble)
		const bubble = container.querySelector('[title="chat:queuedMessages.clickToEdit"]') as HTMLElement | null
		expect(bubble).toBeTruthy()
		fireEvent.click(bubble!)

		// In edit mode the bubble switches to editor background/foreground and
		// no longer uses the soft list-hover treatment.
		const editBubble = container.querySelector(".border.rounded-sm") as HTMLElement | null
		expect(editBubble).toBeTruthy()
		expect(editBubble!.className).toContain("bg-vscode-editor-background")
		expect(editBubble!.className).toContain("text-vscode-editor-foreground")
		expect(editBubble!.className).not.toContain("bg-vscode-list-hoverBackground")

		expect(screen.queryByLabelText("Edit message icon")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Delete message icon")).not.toBeInTheDocument()
	})

	it("renders the feedback bubble without a header label", () => {
		renderRow(makeUserFeedback())
		// The header label ("you said") must not be rendered for user feedback
		expect(screen.queryByText("chat:feedback.youSaid")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("User icon")).not.toBeInTheDocument()
	})
})

describe("ChatRow - assistant text and user edits", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders assistant markdown without a role header", () => {
		renderRow({ ts: 2, type: "say", say: "text", text: "## Updated greeting\n\nHello **Zoo**." })

		expect(screen.getByRole("heading", { name: "Updated greeting" })).toBeInTheDocument()
		expect(screen.getByText("Zoo", { selector: "strong" })).toBeInTheDocument()
		expect(screen.queryByText("chat:text.rooSaid")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Speech bubble icon")).not.toBeInTheDocument()
	})

	it("anchors the preview button to the assistant content and opens that markdown", () => {
		const markdown = "## Updated greeting\n\nHello Zoo.\n\n## Verification\n\nTests pass."
		renderRow({ ts: 2, type: "say", say: "text", text: markdown })

		const preview = screen.getByRole("button", { name: "Open markdown in preview" })
		const previewPosition = preview.parentElement
		expect(previewPosition).toHaveClass("absolute", "top-0", "right-0", "z-10")
		const content = previewPosition?.parentElement
		expect(content).toHaveClass("relative", "pl-6")
		expect(content).toContainElement(screen.getByRole("heading", { name: "Updated greeting" }))
		expect(content).toContainElement(screen.getByRole("heading", { name: "Verification" }))

		fireEvent.click(preview)
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMarkdownPreview", text: markdown })
	})

	it("omits the preview button for simple assistant text", () => {
		renderRow({ ts: 2, type: "say", say: "text", text: "The greeting is updated." })

		expect(screen.getByText("The greeting is updated.")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Open markdown in preview" })).not.toBeInTheDocument()
	})

	it("keeps the user edits accordion inside the right-aligned width constraint", () => {
		const { container } = renderRow(
			{
				ts: 3,
				type: "say",
				say: "user_feedback_diff",
				text: JSON.stringify({ diff: "@@ -1 +1 @@\n-Hello world\n+Hello Zoo" }),
			},
			true,
		)

		const diffContainer = container.firstElementChild
		expect(diffContainer).toHaveClass("max-w-[70%]", "ml-auto")
		expect(diffContainer).toHaveStyle({ width: "100%", marginTop: "-10px" })
		expect(diffContainer).toContainElement(screen.getByText("User Edits"))
		expect(diffContainer).toContainElement(screen.getByText("Hello Zoo"))
	})
})
