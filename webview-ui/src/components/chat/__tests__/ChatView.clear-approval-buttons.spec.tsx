// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.clear-approval-buttons.spec.tsx

import React from "react"
import { render, waitFor, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps } from "../ChatView"

interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
}

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => [mockPlayFunction]),
}))

vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: ClineMessage }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: ClineMessage[]
		itemContent: (index: number, item: ClineMessage) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={item.ts} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		)
	},
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

vi.mock("@src/components/welcome/RooTips", () => ({
	default: () => <div data-testid="roo-tips">Tips content</div>,
}))

vi.mock("@src/components/welcome/RooHero", () => ({
	default: () => <div data-testid="roo-hero">Hero content</div>,
}))

vi.mock("../common/TelemetryBanner", () => ({
	default: () => null,
}))

// The i18n mock returns the key itself, so button labels render as their keys.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => <>{children || i18nKey}</>,
}))

const RUN_BUTTON_LABEL = "chat:runCommand.title"
const DENY_BUTTON_LABEL = "chat:reject.title"

const hydrateState = (clineMessages: ClineMessage[]) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages,
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				cloudIsAuthenticated: false,
				telemetrySetting: "enabled",
			},
		},
		"*",
	)
}

const dispatchExtensionMessage = (data: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

const renderChatView = (props: Partial<ChatViewProps> = {}) =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const commandAsk = (): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask: "command", ts: 2, text: "echo hi", partial: false },
]

describe("ChatView clearApprovalButtons handling", () => {
	beforeEach(() => vi.clearAllMocks())

	it("hides the Run/Deny buttons without sending an askResponse", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(commandAsk())
		})

		// The command ask paints the approval buttons.
		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
		})

		const postMessageCallsBefore = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.length

		await act(async () => {
			dispatchExtensionMessage({ type: "clearApprovalButtons" })
		})

		// Buttons are cleared via the shared pathway.
		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		// The backend already responded, so the webview must not send another response.
		const askResponseCalls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]) => msg?.type === "askResponse",
		)
		expect(askResponseCalls).toHaveLength(0)
		// And no new postMessage was triggered by the clear itself.
		expect((vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(postMessageCallsBefore)
	})
})
