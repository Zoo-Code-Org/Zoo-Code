// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.clear-approval-buttons.spec.tsx

import React from "react"
import { render, waitFor, act, fireEvent } from "@/utils/test-utils"
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
	isAnswered?: boolean
	checkpoint?: Record<string, unknown>
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
	default: function MockChatRow({
		message,
		completionCheckpoint,
	}: {
		message: ClineMessage
		completionCheckpoint?: { ts: number; commitHash: string }
	}) {
		return (
			<div data-testid="chat-row">
				{JSON.stringify(message)}
				{((message.type === "say" && message.say === "completion_result") ||
					(message.type === "ask" && message.ask === "completion_result" && message.text)) &&
				completionCheckpoint ? (
					<div data-testid="completion-checkpoint-actions">
						<button type="button">chat:seeNewChanges.title</button>
						<button type="button">chat:restoreChanges.title</button>
					</div>
				) : null}
			</div>
		)
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
const START_NEW_TASK_BUTTON_LABEL = "chat:startNewTask.title"
const SEE_NEW_CHANGES_BUTTON_LABEL = "chat:seeNewChanges.title"
const RESTORE_CHANGES_BUTTON_LABEL = "chat:restoreChanges.title"

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

const autoApprovedCommandAsk = (): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask: "command", ts: 2, text: "echo hi", partial: false, isAnswered: true },
]

const completionAskWithoutCheckpoint = (): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask: "completion_result", ts: 2, text: "Task complete", partial: false },
]

const completionAskWithCheckpoint = (): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{
		type: "say",
		say: "checkpoint_saved",
		ts: 2,
		text: "checkpoint-after-user-prompt",
		checkpoint: { suppressMessage: true },
	},
	{ type: "say", say: "completion_result", ts: 3, text: "Task complete" },
	{ type: "ask", ask: "completion_result", ts: 4, text: "", partial: false },
]

const askOnlyCompletionWithCheckpoint = (): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{
		type: "say",
		say: "checkpoint_saved",
		ts: 2,
		text: "checkpoint-after-user-prompt",
		checkpoint: { suppressMessage: true },
	},
	{ type: "ask", ask: "completion_result", ts: 3, text: "Task complete", partial: false },
]

describe("ChatView approval button behavior", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows Run/Deny buttons for a command ask that requires manual approval", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(commandAsk())
		})

		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
		})
	})

	it("never shows Run/Deny buttons when the command ask is already answered (auto-approved)", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(autoApprovedCommandAsk())
		})

		// isAnswered:true on the message means the ask was resolved before the
		// webview rendered it -- buttons must never appear.
		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		// No askResponse should have been sent, since the backend already responded.
		const askResponseCalls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]) => msg?.type === "askResponse",
		)
		expect(askResponseCalls).toHaveLength(0)
	})

	it("shows Kilo-style completion checkpoint actions inline when a latest-prompt checkpoint is available", async () => {
		const { queryByText, queryByTestId } = renderChatView()

		await act(async () => {
			hydrateState(completionAskWithCheckpoint())
		})

		await waitFor(() => {
			expect(queryByTestId("completion-checkpoint-actions")).toBeInTheDocument()
			expect(queryByText(SEE_NEW_CHANGES_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(RESTORE_CHANGES_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(START_NEW_TASK_BUTTON_LABEL)).toBeInTheDocument()
		})
	})

	it("shows inline checkpoint actions for ask-only completion rows with text", async () => {
		const { queryByText, queryByTestId } = renderChatView()

		await act(async () => {
			hydrateState(askOnlyCompletionWithCheckpoint())
		})

		await waitFor(() => {
			expect(queryByTestId("completion-checkpoint-actions")).toBeInTheDocument()
			expect(queryByText(SEE_NEW_CHANGES_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(RESTORE_CHANGES_BUTTON_LABEL)).toBeInTheDocument()
		})
	})

	it("keeps Start New Task for completion results without a latest-prompt checkpoint", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(completionAskWithoutCheckpoint())
		})

		await waitFor(() => {
			expect(queryByText(START_NEW_TASK_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(SEE_NEW_CHANGES_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(RESTORE_CHANGES_BUTTON_LABEL)).not.toBeInTheDocument()
		})
	})

	it("keeps Start New Task as the bottom completion action even when inline checkpoint actions are available", async () => {
		const { getByText } = renderChatView()

		await act(async () => {
			hydrateState(completionAskWithCheckpoint())
		})

		await waitFor(() => {
			expect(getByText(START_NEW_TASK_BUTTON_LABEL)).toBeInTheDocument()
		})

		fireEvent.click(getByText(START_NEW_TASK_BUTTON_LABEL))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearTask" })
	})
})
