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

// Narrow subset of the real ChatTextArea props the double consumes.
interface MockChatTextAreaProps {
	onSend: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	setInputValueGenerated?: (value: string) => void
}

// ChatTextArea double: an input whose Enter triggers onSend and whose
// changes flow through the provided setInputValue. Programmatic updates
// mirror the real component and keep the authorization scope.
vi.mock("../ChatTextArea", async () => {
	const React = await import("react")

	const ChatTextAreaComponent = React.forwardRef(function MockChatTextArea(
		props: MockChatTextAreaProps,
		_ref: unknown,
	) {
		React.useEffect(() => {
			const listener = (event: MessageEvent) => {
				if (event.data?.type === "enhancedPrompt" && typeof event.data.text === "string") {
					const update = props.setInputValueGenerated ?? props.setInputValue
					update?.(event.data.text)
				}
			}
			window.addEventListener("message", listener)
			return () => window.removeEventListener("message", listener)
		}, [props])

		return (
			<div data-testid="chat-textarea">
				<input
					type="text"
					value={props.inputValue || ""}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.setInputValue?.(e.target.value)}
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
	VSCodeCheckbox: ({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeTextField: ({
		value,
		onInput,
		placeholder,
	}: {
		value?: string
		onInput?: (e: { target: { value: string } }) => void
		placeholder?: string
	}) => (
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

const generated = (text: string) => ({ text, source: "generated" as const })
const user = (text: string) => ({ text, source: "user" as const })

describe("ChatView - add-to-context mention segments", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("sends all generated segments when add-to-context carries no user input", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ segments: [generated("context with @/secret code")] })
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({
			text: "context with @/secret code",
			segments: [generated("context with @/secret code")],
		})
	})

	it("keeps the user segment the extension named", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ segments: [generated("context with @/secret "), user("code")] })
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ segments: [generated("context with @/secret "), user("code")] })
	})

	it("treats text as generated when the sender omits segments", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({})
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ segments: [generated("context with @/secret code")] })
	})

	it("treats text as generated when the segments do not match it", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ segments: [user("something else")] })
		const message = await sendNewTask(getByTestId)

		expect(message).toMatchObject({ segments: [generated("context with @/secret code")] })
	})

	it("marks only the typed text as user text after a manual edit", async () => {
		const { getByTestId } = renderChatView()

		await addGeneratedContext({ segments: [generated("context with @/secret code")] })

		const input = getByTestId("chat-textarea").querySelector("input")!
		await act(async () => {
			fireEvent.change(input, { target: { value: "context with @/secret code and @/ok" } })
		})

		const message = await sendNewTask(getByTestId)
		expect(message).toMatchObject({
			segments: [generated("context with @/secret code"), user(" and @/ok")],
		})
	})

	it("keeps all text user text when nothing generated was added", async () => {
		const { getByTestId } = renderChatView()

		const input = getByTestId("chat-textarea").querySelector("input")!
		await act(async () => {
			fireEvent.change(input, { target: { value: "my own task with @/ok" } })
		})

		const message = await sendNewTask(getByTestId)
		expect(message).toMatchObject({ segments: [user("my own task with @/ok")] })
	})

	it("appends inserted segments after typed text", async () => {
		const { getByTestId } = renderChatView()

		const input = getByTestId("chat-textarea").querySelector("input")!
		await act(async () => {
			fireEvent.change(input, { target: { value: "mine" } })
		})
		await act(async () => {
			window.postMessage(
				{
					type: "invoke",
					invoke: "setChatBoxMessage",
					text: "ctx @/secret",
					segments: [generated("ctx @/secret")],
				},
				"*",
			)
		})
		await waitFor(() => {
			expect(getChatBoxValue()).toBe("mine ctx @/secret")
		})

		const message = await sendNewTask(getByTestId)
		expect(message).toMatchObject({ segments: [user("mine"), generated(" ctx @/secret")] })
	})

	it("makes an enhanced prompt all generated, even over a typed draft", async () => {
		const { getByTestId } = renderChatView()

		const input = getByTestId("chat-textarea").querySelector("input")!
		await act(async () => {
			fireEvent.change(input, { target: { value: "my draft" } })
		})
		await act(async () => {
			window.postMessage({ type: "enhancedPrompt", text: "enhanced with @/secret" }, "*")
		})
		await waitFor(() => {
			expect(getChatBoxValue()).toBe("enhanced with @/secret")
		})

		const message = await sendNewTask(getByTestId)
		expect(message).toMatchObject({
			text: "enhanced with @/secret",
			segments: [generated("enhanced with @/secret")],
		})
	})
})
