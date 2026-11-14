// npx vitest run src/components/chat/__tests__/ChatView.add-to-context-authorization.spec.tsx

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithExtensionState, waitFor, act, fireEvent } from "@/utils/test-utils"

import ChatView, { ChatViewProps } from "../ChatView"

// Mock vscode API
const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }))
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

vi.mock("use-sound", () => ({
	default: vi.fn(() => [vi.fn()]),
}))

vi.mock("../ChatRow", () => ({
	default: () => null,
}))

vi.mock("../TaskHeader", () => ({
	default: () => null,
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: () => <div data-testid="virtuoso-item-list" />,
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: () => null,
}))

vi.mock("../Announcement", () => ({
	default: () => null,
}))

vi.mock("../QueuedMessages", () => ({
	QueuedMessages: () => null,
}))

vi.mock("@src/components/welcome/RooTips", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/RooHero", () => ({
	default: () => null,
}))

vi.mock("../common/TelemetryBanner", () => ({
	default: () => null,
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: () => {} },
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// ChatTextArea double: an input whose Enter triggers onSend and whose
// changes flow through the provided setInputValue.
vi.mock("../ChatTextArea", async () => {
	const React = await import("react")

	const ChatTextAreaComponent = React.forwardRef(function MockChatTextArea(props: any, _ref: unknown) {
		return (
			<div data-testid="chat-textarea">
				<input
					type="text"
					value={props.inputValue || ""}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.setInputValue(e.target.value)}
					onKeyDown={(e: React.KeyboardEvent) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							props.onSend()
						}
					}}
				/>
			</div>
		)
	})

	return { default: ChatTextAreaComponent, ChatTextArea: ChatTextAreaComponent }
})

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, placeholder }: any) => (
		<input
			type="text"
			value={value}
			onChange={(e) => onInput?.({ target: { value: e.target.value } })}
			placeholder={placeholder}
		/>
	),
	VSCodeLink: ({ children, href }: { children: React.ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodeTag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const renderChatView = () => renderWithExtensionState(<ChatView {...defaultProps} />)

const sendNewTask = async (getByTestId: (id: string) => HTMLElement) => {
	await act(async () => {
		fireEvent.keyDown(getByTestId("chat-textarea").querySelector("input")!, { key: "Enter" })
	})
	await waitFor(() => expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" })))
	return mockPostMessage.mock.calls.find(([m]) => m.type === "newTask")?.[0]
}

const addGeneratedContext = async (payload: Record<string, unknown>) => {
	await act(async () => {
		window.postMessage(
			{ type: "invoke", invoke: "setChatBoxMessage", text: "context with @/secret code", ...payload },
			"*",
		)
	})
	await waitFor(() => {
		expect(getChatBoxValue()).toBe("context with @/secret code")
	})
}

const getChatBoxValue = () => {
	const input = document.querySelector('[data-testid="chat-textarea"] input') as HTMLInputElement | null
	return input?.value ?? ""
}

describe("ChatView - add-to-context mention authorization", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("sends no authorized substring when add-to-context carries no user input", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ authorizedMentionText: "" })
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ text: "context with @/secret code", authorizedMentionText: "" })
	})

	it("sends only the user-authored substring the extension authorized", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ authorizedMentionText: "explain this" })
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ authorizedMentionText: "explain this" })
	})

	it("authorizes the whole value when no authorization was recorded", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({})
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ authorizedMentionText: "context with @/secret code" })
	})

	it("re-authorizes the whole value after a manual edit", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ authorizedMentionText: "" })

		const input = getByTestId("chat-textarea").querySelector("input")!
		await act(async () => {
			fireEvent.change(input, { target: { value: "my own task with @/ok" } })
		})

		const message = await sendNewTask(getByTestId)
		expect(message).toMatchObject({ authorizedMentionText: "my own task with @/ok" })
	})
})
