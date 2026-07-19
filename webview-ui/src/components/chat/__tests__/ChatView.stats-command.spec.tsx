// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.stats-command.spec.tsx

import React from "react"
import { render, waitFor, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps } from "../ChatView"

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock use-sound hook
const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => {
		return [mockPlayFunction]
	}),
}))

// Mock ChatRow
vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: any }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

// Mock AutoApproveMenu
vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

// Mock react-virtuoso
vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: any[]
		itemContent: (index: number, item: any) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={index} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		)
	},
}))

// Mock VersionIndicator
vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

// Mock Announcement
vi.mock("../Announcement", () => ({
	default: function MockAnnouncement({ hideAnnouncement }: { hideAnnouncement: () => void }) {
		return (
			<div data-testid="announcement-modal">
				<button onClick={hideAnnouncement}>Close</button>
			</div>
		)
	},
}))

// Mock QueuedMessages
vi.mock("../QueuedMessages", () => ({
	QueuedMessages: () => null,
}))

// Mock RooTips
vi.mock("@src/components/welcome/RooTips", () => ({
	default: function MockRooTips() {
		return <div data-testid="roo-tips">Tips content</div>
	},
}))

// Mock RooHero
vi.mock("@src/components/welcome/RooHero", () => ({
	default: function MockRooHero() {
		return <div data-testid="roo-hero">Hero content</div>
	},
}))

// Mock TelemetryBanner
vi.mock("../common/TelemetryBanner", () => ({
	default: function MockTelemetryBanner() {
		return null
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// ── ChatTextArea mock ───────────────────────────────────────────────────────

interface ChatTextAreaProps {
	onSend: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	sendingDisabled?: boolean
}

const mockInputRef = React.createRef<HTMLInputElement>()

vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")

	const ChatTextAreaComponent = mockReact.forwardRef(function MockChatTextArea(
		props: ChatTextAreaProps,
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		mockReact.useImperativeHandle(ref, () => ({
			focus: vi.fn(),
		}))

		return (
			<div data-testid="chat-textarea">
				<input
					ref={mockInputRef}
					type="text"
					value={props.inputValue || ""}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
						if (props.setInputValue) {
							props.setInputValue(e.target.value)
						}
					}}
					onKeyDown={(e: React.KeyboardEvent) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							props.onSend()
						}
					}}
					data-sending-disabled={props.sendingDisabled}
				/>
			</div>
		)
	})

	return {
		default: ChatTextAreaComponent,
		ChatTextArea: ChatTextAreaComponent,
	}
})

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: function MockVSCodeButton({
		children,
		onClick,
	}: {
		children: React.ReactNode
		onClick?: () => void
	}) {
		return <button onClick={onClick}>{children}</button>
	},
	VSCodeTextField: function MockVSCodeTextField({
		value,
		onInput,
	}: {
		value?: string
		onInput?: (e: { target: { value: string } }) => void
	}) {
		return <input type="text" value={value} onChange={(e) => onInput?.({ target: { value: e.target.value } })} />
	},
	VSCodeLink: function MockVSCodeLink({ children }: { children: React.ReactNode }) {
		return <a>{children}</a>
	},
}))

// ── Test helpers ────────────────────────────────────────────────────────────

interface ExtensionState {
	version: string
	clineMessages: any[]
	taskHistory: any[]
	shouldShowAnnouncement: boolean
	allowedCommands: string[]
	alwaysAllowExecute: boolean
	[key: string]: any
}

const mockPostMessage = (state: Partial<ExtensionState>) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				cloudIsAuthenticated: false,
				telemetrySetting: "enabled",
				...state,
			},
		},
		"*",
	)
}

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

const renderChatView = (props: Partial<ChatViewProps> = {}) => {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ChatView - /stats command interception", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("intercepts exact /stats and sends switchTab to stats", async () => {
		renderChatView()

		// Hydrate state
		mockPostMessage({})

		// Wait for hydration
		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		// Type /stats and press Enter
		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "/stats" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Verify switchTab message was sent
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "switchTab",
				tab: "stats",
			}),
		)
	})

	it("does not send newTask or askResponse for exact /stats", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "/stats" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Verify no newTask or askResponse was sent
		const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
		const llmCalls = calls.filter(([msg]) => msg?.type === "newTask" || msg?.type === "askResponse")
		expect(llmCalls).toHaveLength(0)
	})

	it("does not intercept /stats with arguments (e.g. /stats foo)", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "/stats foo" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Should NOT send switchTab to stats
		const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
		const statsTabCalls = calls.filter(([msg]) => msg?.type === "switchTab" && msg?.tab === "stats")
		expect(statsTabCalls).toHaveLength(0)

		// Should send as normal message (newTask since no messages)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "newTask",
				text: "/stats foo",
			}),
		)
	})

	it("does not intercept /stats with trailing whitespace only (trimmed to /stats)", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		// "/stats   " trims to "/stats" → should be intercepted
		fireEvent.change(input, { target: { value: "/stats   " } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "switchTab",
				tab: "stats",
			}),
		)
	})

	it("intercepts /stats even during streaming (busy state)", async () => {
		renderChatView()

		// Hydrate with a streaming state
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Working on something",
				},
				{
					type: "say",
					say: "text",
					ts: Date.now(),
					text: "Streaming response...",
					partial: true,
				},
			],
		})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "/stats" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// /stats should still be intercepted even during streaming
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "switchTab",
				tab: "stats",
			}),
		)

		// Should NOT be queued as a message
		const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
		const queueCalls = calls.filter(([msg]) => msg?.type === "queueMessage")
		expect(queueCalls).toHaveLength(0)
	})

	it("does not intercept regular messages", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "Hello world" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Should send as newTask (no existing messages)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "newTask",
				text: "Hello world",
			}),
		)

		// Should NOT send switchTab to stats
		const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
		const statsTabCalls = calls.filter(([msg]) => msg?.type === "switchTab" && msg?.tab === "stats")
		expect(statsTabCalls).toHaveLength(0)
	})

	it("does not intercept /stats inside code block text", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		// A message that contains /stats but is not exactly /stats.
		// Uses spaces instead of newlines because the mocked ChatTextArea
		// uses an <input type="text"> which doesn't support newlines.
		const codeBlockMessage = "``` /stats ```"
		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: codeBlockMessage } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Should NOT send switchTab to stats — it's a regular message
		const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
		const statsTabCalls = calls.filter(([msg]) => msg?.type === "switchTab" && msg?.tab === "stats")
		expect(statsTabCalls).toHaveLength(0)

		// Should be sent as newTask (wait for it since state update is async)
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "newTask",
					text: codeBlockMessage,
				}),
			)
		})
	})

	it("clears input after /stats interception", async () => {
		renderChatView()

		mockPostMessage({})

		await waitFor(() => {
			expect(document.querySelector('[data-testid="chat-textarea"]')).toBeTruthy()
		})

		const input = mockInputRef.current!
		fireEvent.change(input, { target: { value: "/stats" } })
		fireEvent.keyDown(input, { key: "Enter" })

		// Input should be cleared
		expect(input.value).toBe("")
	})
})
