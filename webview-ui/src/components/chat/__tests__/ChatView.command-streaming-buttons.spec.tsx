// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.command-streaming-buttons.spec.tsx

import React from "react"
import { renderWithExtensionState, waitFor, act, screen } from "@/utils/test-utils"

import ChatView, { ChatViewProps } from "../ChatView"

interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
	isAnswered?: boolean
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
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("react-i18next", () => ({
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

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const renderChatView = (props: Partial<ChatViewProps> = {}) =>
	renderWithExtensionState(<ChatView {...defaultProps} {...props} />)

// ExecuteCommandTool.handlePartial emits one ask per partial tool call, so the
// webview sees the command ask with partial true while the call still streams.
const commandAsk = (partial: boolean, isAnswered?: boolean): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask: "command", ts: 2, text: "echo hi", partial, isAnswered },
]

// An absence assertion alone can pass before the message effect flushed its
// state updates, so first prove the row rendered, then let every pending
// effect flush, and only then look for buttons.
const settle = async () => {
	await waitFor(() => expect(screen.getAllByTestId("chat-row").length).toBeGreaterThan(0))
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 100))
	})
}

// Invariant NoButtonsWhilePartial (spec CommandAskButtons): a partial command
// ask draws the command and no approval buttons, because no decision can be
// made while the call still streams.
describe("ChatView command ask approval buttons while streaming", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows no Run/Deny buttons while the command ask is partial (the call still streams)", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(commandAsk(true))
		})
		await settle()

		expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
		expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
	})

	// Invariant ButtonsWhenLive (spec CommandAskButtons): the completed ask
	// that waits for the user draws both buttons, and they accept a click.
	it("shows enabled Run/Deny buttons when the command ask is complete and unanswered", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(commandAsk(false))
		})

		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
		})
		// Enabled state must be asserted on the button element, not its label
		// span: a span passes toBeEnabled even when its button is disabled.
		expect(screen.getByRole("button", { name: RUN_BUTTON_LABEL })).toBeEnabled()
		expect(screen.getByRole("button", { name: DENY_BUTTON_LABEL })).toBeEnabled()
	})

	// Replays the TLC sequence on real code: HandlePartial, then AskComplete
	// on the same message ts. The buttons must appear only after completion.
	it("draws the buttons when a streaming command ask completes on the same message", async () => {
		const { queryByText } = renderChatView()

		await act(async () => {
			hydrateState(commandAsk(true))
		})
		await settle()
		expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()

		await act(async () => {
			hydrateState(commandAsk(false))
		})
		await waitFor(() => {
			expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
		})
		expect(screen.getByRole("button", { name: RUN_BUTTON_LABEL })).toBeEnabled()
	})

	// Property sweep from the invariant sentence: the Run/Deny pair is drawn
	// if, and only if, the command ask is complete and not already answered.
	it.each([
		{ partial: false, isAnswered: undefined, shown: true },
		{ partial: true, isAnswered: undefined, shown: false },
		{ partial: false, isAnswered: true, shown: false },
		{ partial: true, isAnswered: true, shown: false },
	])(
		"Run/Deny shown=$shown when the command ask has partial=$partial and isAnswered=$isAnswered",
		async ({ partial, isAnswered, shown }) => {
			const { queryByText } = renderChatView()

			await act(async () => {
				hydrateState(commandAsk(partial, isAnswered))
			})

			if (shown) {
				await waitFor(() => {
					expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
					expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
				})
			} else {
				await settle()
				expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
				expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
			}
		},
	)
})
