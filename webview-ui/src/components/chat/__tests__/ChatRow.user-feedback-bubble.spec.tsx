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

	it("names the message control from its content and describes editing separately", () => {
		renderRow(makeUserFeedback())

		const messageControl = screen.getByRole("button", { name: "hello bubble" })
		expect(messageControl).toHaveAccessibleDescription("chat:queuedMessages.clickToEdit")
	})

	it("keeps image-only messages editable by an accessible name", () => {
		renderRow({ ...makeUserFeedback(), text: "", images: ["data:image/png;base64,AA=="] })

		const messageControl = screen.getByRole("button", {
			name: "common:confirmation.editMessage",
			description: "chat:queuedMessages.clickToEdit",
		})
		fireEvent.click(messageControl)
		expect(screen.getByRole("textbox")).toHaveValue("")
	})

	it("still renders the message text", () => {
		const { container } = renderRow(makeUserFeedback())
		const bubble = container.querySelector(".cursor-text") as HTMLElement | null

		expect(bubble).toBeTruthy()
		expect(bubble!.textContent).toContain("hello bubble")
	})

	it("places keyboard-operable edit/delete action buttons outside the bubble and wires them up", () => {
		const { container } = renderRow(makeUserFeedback())

		// Both controls are real buttons with translated accessible names, so
		// keyboard and screen-reader users can reach them.
		const editButton = screen.getByRole("button", { name: "common:confirmation.editMessage" })
		const deleteButton = screen.getByRole("button", { name: "common:confirmation.deleteMessage" })
		expect(editButton.tagName).toBe("BUTTON")
		expect(deleteButton.tagName).toBe("BUTTON")

		// The bubble must NOT contain the edit/delete controls.
		const bubble = container.querySelector(".cursor-text") as HTMLElement | null
		expect(bubble).toBeTruthy()
		expect(bubble!).not.toContainElement(editButton)
		expect(bubble!).not.toContainElement(deleteButton)

		// Clicking delete forwards the message timestamp to the extension host.
		fireEvent.click(deleteButton)
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: 1 })

		// Clicking edit enters edit mode: the bubble switches to the editor background.
		fireEvent.click(editButton)
		const editBubble = container.querySelector(".border.rounded-sm") as HTMLElement | null
		expect(editBubble).toBeTruthy()
		expect(editBubble!.className).toContain("bg-vscode-editor-background")
	})

	describe.each([
		{ name: "Enter", key: "Enter", input: "{Enter}" },
		{ name: "Space", key: " ", input: " " },
	])("$name keyboard activation", ({ key, input }) => {
		const originalFocusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!

		beforeEach(() => {
			// vitest.setup.ts replaces focus with a no-op for FAST components. Borrow
			// JSDOM's native focus from a fresh realm so keyboard navigation works here.
			const frame = document.createElement("iframe")
			document.body.appendChild(frame)
			const nativeFocus = frame.contentDocument!.createElement("button").focus
			frame.remove()
			Object.defineProperty(HTMLElement.prototype, "focus", {
				configurable: true,
				writable: true,
				value: nativeFocus,
			})
		})

		afterEach(() => {
			Object.defineProperty(HTMLElement.prototype, "focus", originalFocusDescriptor)
		})

		it("enters edit mode from the message text", async () => {
			const user = userEvent.setup()
			renderRow(makeUserFeedback())

			await user.tab()
			expect(screen.getByRole("button", { name: "hello bubble" })).toHaveFocus()
			await user.keyboard(input)

			expect(screen.getByRole("textbox")).toHaveValue("hello bubble")
			expect(screen.queryByRole("button", { name: "hello bubble" })).not.toBeInTheDocument()
		})

		it("does not enter edit mode from the message text while streaming", () => {
			renderRow(makeUserFeedback(), false, true)
			const messageControl = screen.getByRole("button", { name: "hello bubble" })
			expect(messageControl).toHaveAttribute("aria-disabled", "true")
			expect(messageControl).toHaveAttribute("tabindex", "-1")

			// Dispatch directly to exercise the guard even though streaming removes the tab stop.
			fireEvent.keyDown(messageControl, { key })

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
			expect(messageControl).toBeInTheDocument()
			expect(messageControl).toHaveTextContent("hello bubble")
		})

		it("activates the edit action button", async () => {
			const user = userEvent.setup()
			renderRow(makeUserFeedback())

			await user.tab()
			await user.tab()
			expect(screen.getByRole("button", { name: "common:confirmation.editMessage" })).toHaveFocus()
			await user.keyboard(input)

			expect(screen.getByRole("textbox")).toHaveValue("hello bubble")
		})

		it("activates the delete action button without entering edit mode", async () => {
			const user = userEvent.setup()
			renderRow(makeUserFeedback())

			await user.tab()
			await user.tab()
			await user.tab()
			expect(screen.getByRole("button", { name: "common:confirmation.deleteMessage" })).toHaveFocus()
			await user.keyboard(input)

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: 1 })
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		})
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

		// The edit/delete controls remain mounted but hidden via visibility: hidden.
		const editButton = screen.getByLabelText("common:confirmation.editMessage")
		const deleteButton = screen.getByLabelText("common:confirmation.deleteMessage")
		expect(editButton.style.visibility).toBe("hidden")
		expect(deleteButton.style.visibility).toBe("hidden")
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

		expect(screen.queryByLabelText("common:confirmation.editMessage")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("common:confirmation.deleteMessage")).not.toBeInTheDocument()
	})

	it("identifies the user with a visually hidden localized speaker label", () => {
		renderRow(makeUserFeedback())
		expect(screen.getByText("chat:feedback.youSaid")).toHaveClass("sr-only")
		expect(screen.getByText("chat:feedback.youSaid")).not.toHaveAttribute("aria-hidden")
		expect(screen.queryByLabelText("User icon")).not.toBeInTheDocument()
	})

	it("opens a mention without also entering edit mode", () => {
		const { container } = renderRow({
			ts: 1,
			type: "say",
			say: "user_feedback",
			text: "please check @problems for details",
		})

		fireEvent.click(screen.getByText("@problems"))

		// The mention click opens the mention...
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "problems" })
		// ...and must not bubble into the row's click-to-edit handler.
		const bubbleWrapper = container.querySelector(".border.rounded-sm") as HTMLElement | null
		expect(bubbleWrapper).toBeTruthy()
		expect(bubbleWrapper!.className).not.toContain("bg-vscode-editor-background")
	})
})

describe("ChatRow - assistant text and user edits", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("identifies the assistant with a visually hidden localized speaker label", () => {
		renderRow({ ts: 2, type: "say", say: "text", text: "## Updated greeting\n\nHello **Zoo**." })

		expect(screen.getByRole("heading", { name: "Updated greeting" })).toBeInTheDocument()
		expect(screen.getByText("Zoo", { selector: "strong" })).toBeInTheDocument()
		expect(screen.getByText("chat:text.rooSaid")).toHaveClass("sr-only")
		expect(screen.getByText("chat:text.rooSaid")).not.toHaveAttribute("aria-hidden")
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
		expect(screen.getByText("chat:feedback.youSaid")).toHaveClass("sr-only")
		expect(diffContainer).toHaveClass("max-w-[70%]", "ml-auto")
		expect(diffContainer).toHaveStyle({ width: "100%", marginTop: "-10px" })
		expect(diffContainer).toContainElement(screen.getByText("User Edits"))
		expect(diffContainer).toContainElement(screen.getByText("Hello Zoo"))
	})
})
