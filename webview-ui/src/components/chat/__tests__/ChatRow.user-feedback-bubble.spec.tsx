import React from "react"
import userEvent from "@testing-library/user-event"
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

function renderRow(message: ClineMessage, isStreaming = false) {
	return renderWithExtensionState(
		<ChatRowContent
			message={message}
			isExpanded={false}
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

	it("places the action bar as the bubble's immediate next sibling, outside the bubble", () => {
		const { container } = renderRow(makeUserFeedback())

		const bubble = container.querySelector(".cursor-text") as HTMLElement | null
		const actionBar = Array.from(container.querySelectorAll("div")).find(
			(el) => el.className.includes("flex") && el.className.includes("gap-2") && el.className.includes("pr-1"),
		) as HTMLElement | undefined

		expect(bubble).toBeTruthy()
		expect(actionBar).toBeTruthy()

		// The action bar must share the bubble's parent and immediately follow it.
		expect(actionBar!.parentElement).toBe(bubble!.parentElement)
		expect(bubble!.nextElementSibling).toBe(actionBar)

		expect(actionBar!.querySelector('[aria-label="chat:edit"]')).toBeTruthy()
		expect(actionBar!.querySelector('[aria-label="common:confirmation.deleteMessage"]')).toBeTruthy()

		// The bubble must NOT contain the edit/delete controls
		expect(bubble!.querySelector('[aria-label="chat:edit"]')).toBeFalsy()
		expect(bubble!.querySelector('[aria-label="common:confirmation.deleteMessage"]')).toBeFalsy()
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
	})

	it("renders the feedback bubble without a header label", () => {
		renderRow(makeUserFeedback())
		// The header label ("you said") must not be rendered for user feedback
		expect(screen.queryByText("chat:feedback.youSaid")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("User icon")).not.toBeInTheDocument()
	})

	it("renders the edit/delete actions as keyboard-focusable buttons", () => {
		const { container } = renderRow(makeUserFeedback())

		const editButton = container.querySelector('[aria-label="chat:edit"]') as HTMLButtonElement | null
		const deleteButton = container.querySelector(
			'[aria-label="common:confirmation.deleteMessage"]',
		) as HTMLButtonElement | null

		expect(editButton?.tagName).toBe("BUTTON")
		expect(deleteButton?.tagName).toBe("BUTTON")
		expect(editButton?.getAttribute("type")).toBe("button")
		expect(deleteButton?.getAttribute("type")).toBe("button")
	})

	it("enters edit mode when the edit action is clicked", () => {
		const { container } = renderRow(makeUserFeedback())

		const editButton = container.querySelector('[aria-label="chat:edit"]') as HTMLElement | null
		expect(editButton).toBeTruthy()
		fireEvent.click(editButton!)

		// Clicking edit enters inline edit mode for the feedback message
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null
		expect(textarea).toBeTruthy()
	})

	it("deletes the message when the delete action is clicked", () => {
		mockPostMessage.mockClear()
		const { container } = renderRow(makeUserFeedback())

		const deleteButton = container.querySelector(
			'[aria-label="common:confirmation.deleteMessage"]',
		) as HTMLElement | null
		expect(deleteButton).toBeTruthy()
		fireEvent.click(deleteButton!)

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: 1 })
	})

	it("disables the edit/delete actions while streaming and sends no message when activated", () => {
		const { container } = renderRow(makeUserFeedback(), true)

		const editButton = container.querySelector('[aria-label="chat:edit"]') as HTMLButtonElement | null
		const deleteButton = container.querySelector(
			'[aria-label="common:confirmation.deleteMessage"]',
		) as HTMLButtonElement | null

		expect(editButton).toBeTruthy()
		expect(deleteButton).toBeTruthy()
		expect(editButton!.disabled).toBe(true)
		expect(deleteButton!.disabled).toBe(true)

		mockPostMessage.mockClear()
		fireEvent.click(editButton!)
		fireEvent.click(deleteButton!)

		// No edit mode entered and no delete message posted while streaming.
		expect(container.querySelector("textarea")).not.toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	it("opens a mention without entering edit mode when the mention inside the bubble is clicked", async () => {
		mockPostMessage.mockClear()
		const user = userEvent.setup()
		const message = {
			ts: 1,
			type: "say",
			say: "user_feedback",
			text: "hello @/path/to/file.txt",
		} as ClineMessage
		const { container } = renderRow(message)

		const bubble = container.querySelector(".cursor-text") as HTMLElement | null
		expect(bubble).toBeTruthy()

		const mention = bubble!.querySelector("[data-mention]") as HTMLElement | null
		expect(mention).toBeTruthy()

		await user.click(mention!)

		// The mention click opens its target but must not enter edit mode.
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "/path/to/file.txt" })
		expect(container.querySelector("textarea")).not.toBeInTheDocument()
	})
})
