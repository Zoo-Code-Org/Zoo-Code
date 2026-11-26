// pnpm --dir webview-ui exec vitest run src/components/chat/__tests__/ChatView.pending-ask-error-say.spec.tsx

import React from "react"
import { renderWithExtensionState, waitFor, act, fireEvent, screen } from "@/utils/test-utils"

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
	isNonInteractive?: boolean
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

vi.mock("../AutoApproveMenu", () => ({ default: () => null }))
vi.mock("../../common/VersionIndicator", () => ({ default: vi.fn(() => null) }))
vi.mock("@src/components/welcome/RooTips", () => ({ default: () => null }))
vi.mock("@src/components/welcome/RooHero", () => ({ default: () => null }))
vi.mock("../common/TelemetryBanner", () => ({ default: () => null }))

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

// The i18n mock returns the key itself, so button labels render as their keys.
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => <>{children || i18nKey}</>,
}))

const SAVE_BUTTON_LABEL = "chat:save.title"
const DENY_BUTTON_LABEL = "chat:reject.title"
const PROCEED_BUTTON_LABEL = "chat:proceedWhileRunning.title"
const KILL_BUTTON_LABEL = "chat:killCommand.title"

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

const renderChatView = () => renderWithExtensionState(<ChatView {...defaultProps} />)

const taskMessage: ClineMessage = { type: "say", say: "task", ts: 1, text: "Initial task" }

const diffAsk: ClineMessage = {
	type: "ask",
	ask: "tool",
	ts: 2,
	text: JSON.stringify({ tool: "appliedDiff", path: "src/core/task/Task.ts", diff: "@@ -1,2 +1,2 @@" }),
	partial: false,
}

const commandOutputAsk: ClineMessage = {
	type: "ask",
	ask: "command_output",
	ts: 2,
	text: "echo hi",
	partial: false,
}

// The post-save diagnostics tail appends this row after the approval ask is already
// on screen, with the same isNonInteractive marker the unit sends it with.
const errorSayRow: ClineMessage = {
	type: "say",
	say: "error",
	ts: 3,
	text: "2 problems reported after saving: src/core/task/Task.ts",
	isNonInteractive: true,
}

describe("ChatView when a diagnostics error say follows a pending ask", () => {
	beforeEach(() => vi.clearAllMocks())

	// The ask and the appended row arrive in two state snapshots, which is the order the
	// extension posts them in. Hydrating both at once would never have shown the ask UI,
	// so it could not prove that the trailing row leaves it standing. Each step asserts
	// its own expected state: an absence check would otherwise pass vacuously when the
	// ask UI never appeared at all.
	const hydrateAskThenError = async (ask: ClineMessage, errorRow: ClineMessage, firstLabel: string) => {
		await act(async () => {
			hydrateState([taskMessage, ask])
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: firstLabel })).not.toBeDisabled()
		})
		await act(async () => {
			hydrateState([taskMessage, ask, errorRow])
		})
	}

	it("keeps the diff approval buttons up and answerable after the error say lands", async () => {
		renderChatView()
		await hydrateAskThenError(diffAsk, errorSayRow, SAVE_BUTTON_LABEL)

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: SAVE_BUTTON_LABEL })).not.toBeNull()
			expect(screen.getByRole("button", { name: SAVE_BUTTON_LABEL })).not.toBeDisabled()
			expect(screen.getByRole("button", { name: DENY_BUTTON_LABEL })).not.toBeDisabled()
		})

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_LABEL }))
		})

		// The user reached the pending ask: the extension gets the yes-button answer for a
		// tool ask, not a terminal operation.
		const askResponses = vi.mocked(vscode.postMessage).mock.calls.filter(([msg]) => msg?.type === "askResponse")
		expect(askResponses).toEqual([
			[expect.objectContaining({ type: "askResponse", askResponse: "yesButtonClicked" })],
		])
		expect(vi.mocked(vscode.postMessage)).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "terminalOperation" }),
		)
	})

	it("does leave the controls up while the error say is still partial", async () => {
		renderChatView()
		await hydrateAskThenError(commandOutputAsk, { ...errorSayRow, partial: true }, PROCEED_BUTTON_LABEL)

		// The handler only clears a command_output ask once the appended row is final
		// (ChatView.tsx:512), so a streamed row must not tear the controls down yet. Whether
		// the extension ever streams an error say is out of scope here; this records the
		// condition the handler keys on.
		await waitFor(() => {
			expect(screen.getByRole("button", { name: PROCEED_BUTTON_LABEL })).not.toBeDisabled()
			expect(screen.getByRole("button", { name: KILL_BUTTON_LABEL })).not.toBeDisabled()
		})
	})

	it("clears the command_output controls once a final error say lands on them", async () => {
		renderChatView()
		await hydrateAskThenError(commandOutputAsk, errorSayRow, PROCEED_BUTTON_LABEL)

		// Contrast case: a final error say must tear down the interactive command_output ask
		// it lands on, which is what keeps this file from only proving that things survive.
		// Scope note measured on this commit: relaxing the branch so that it no longer keys
		// on the ask kind leaves every assertion here true. A pending tool ask is drawn from
		// the message list by ChatRow, and an error say is marked isNonInteractive, so it
		// carries no approval controls of its own. The ask-type condition is therefore not
		// observable at this layer; only the partial check is.
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: PROCEED_BUTTON_LABEL })).toBeNull()
			expect(screen.queryByRole("button", { name: KILL_BUTTON_LABEL })).toBeNull()
		})
	})
})

// Single-snapshot case, kept because the review named it. Measured on this commit:
// with the error say last in a single snapshot, ChatView renders no message rows and
// no approval controls; only the chat input chrome is present. The unit under review
// appends the row in a later snapshot, which is the case the three tests above pin.
// This pins what currently happens and adjudicates nothing: whether a pending ask
// ought to stay visible and answerable behind a trailing error say is a product
// decision, deliberately left open here.
it("renders no message rows or approval controls when a trailing error say shares the snapshot", async () => {
	renderChatView()
	await act(async () => {
		hydrateState([taskMessage, diffAsk, errorSayRow])
	})
	// No virtualized rows at all, so the pending ask never reaches the screen.
	expect(screen.queryByTestId("virtuoso-item-list")).toBeNull()
	expect(screen.queryByTestId("virtuoso-item-0")).toBeNull()
	expect(screen.queryByTestId("virtuoso-item-1")).toBeNull()
	expect(screen.queryByRole("button", { name: SAVE_BUTTON_LABEL })).toBeNull()
	expect(screen.queryByRole("button", { name: DENY_BUTTON_LABEL })).toBeNull()
	expect(screen.queryByRole("button", { name: PROCEED_BUTTON_LABEL })).toBeNull()
	expect(screen.queryByRole("button", { name: KILL_BUTTON_LABEL })).toBeNull()
})
