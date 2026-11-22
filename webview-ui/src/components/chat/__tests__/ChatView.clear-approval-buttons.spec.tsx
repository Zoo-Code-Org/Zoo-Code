// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.clear-approval-buttons.spec.tsx

import React from "react"
import { renderWithExtensionState, waitFor, act, fireEvent, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps, ChatViewRef } from "../ChatView"

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
const RESUME_BUTTON_LABEL = "chat:resumeTask.title"
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

const renderChatView = (props: Partial<ChatViewProps> = {}) =>
	renderWithExtensionState(<ChatView {...defaultProps} {...props} />)

const askMessages = (ask: string): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask, ts: 2, text: "echo hi", partial: false },
]

const commandAsk = (): ClineMessage[] => askMessages("command")

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

	describe("queued message segments", () => {
		const streaming = (): ClineMessage[] => [
			{ type: "say", say: "task", ts: 1, text: "Initial task" },
			{ type: "say", say: "text", ts: 2, text: "working", partial: true },
		]
		const fills = [
			{
				label: "generated",
				fill: () =>
					window.postMessage({ type: "invoke", invoke: "setChatBoxMessage", text: "ctx @/secret" }, "*"),
				value: "ctx @/secret",
				source: "generated",
			},
			{
				label: "typed",
				fill: () => fireEvent.input(screen.getByRole("textbox"), { target: { value: "use @/ok" } }),
				value: "use @/ok",
				source: "user",
			},
		] as const
		const queued = () => vi.mocked(vscode.postMessage).mock.calls.find(([m]) => m.type === "queueMessage")?.[0]

		it.each(fills)("the enqueue button sends $label text with its source", async ({ fill, value, source }) => {
			renderChatView()
			await act(async () => hydrateState(streaming()))
			await act(async () => {
				fill()
			})
			await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(value))
			await act(async () => {
				fireEvent.click(await screen.findByRole("button", { name: "chat:enqueueMessage" }))
			})

			expect(queued()).toMatchObject({ text: value, segments: [{ text: value, source }] })
		})

		it.each(fills)(
			"acceptInput during command_output sends $label text with its source",
			async ({ fill, value, source }) => {
				const ref = React.createRef<ChatViewRef>()
				renderWithExtensionState(<ChatView ref={ref} {...defaultProps} />)
				await act(async () => hydrateState(askMessages("command_output")))
				await act(async () => {
					fill()
				})
				await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(value))
				await act(async () => {
					ref.current!.acceptInput()
				})

				expect(queued()).toMatchObject({ text: value, segments: [{ text: value, source }] })
			},
		)
	})

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

	describe("masked command asks in a full-state snapshot (#998)", () => {
		const task: ClineMessage = { type: "say", say: "task", ts: 1, text: "Initial task" }

		const commandAsk = (ts: number, answered = false): ClineMessage => ({
			type: "ask",
			ask: "command",
			ts,
			text: "git ls-files -u",
			partial: false,
			...(answered ? { isAnswered: true } : {}),
		})

		const say = (kind: string, ts: number, partial = false): ClineMessage => ({
			type: "say",
			say: kind,
			ts,
			// The isStreaming memo parses an api_req_started text as a cost record.
			text: kind === "api_req_started" ? '{"tokensIn":100,"tokensOut":50,"cost":0.001}' : "command output",
			partial,
		})

		// An absence assertion must run after the rows render and the effects
		// flush. Otherwise it passes before the ask was ever presented.
		const settle = async (getAllByTestId: (id: string) => HTMLElement[]) => {
			await waitFor(() => expect(getAllByTestId("chat-row").length).toBeGreaterThan(0))
			await act(async () => {
				await Promise.resolve()
			})
		}

		it.each([
			{ label: "command_output say", tail: say("command_output", 3) },
			{ label: "partial command_output say", tail: say("command_output", 3, true) },
			{ label: "text say", tail: say("text", 3) },
			{ label: "error say", tail: say("error", 3) },
		])(
			"shows Run/Deny when the snapshot ends in a $label after an unanswered command ask",
			async ({ tail }: { tail: ClineMessage }) => {
				const { queryByText } = renderChatView()

				await act(async () => {
					hydrateState([task, commandAsk(2), tail])
				})

				await waitFor(
					() => {
						expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
						expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
					},
					// A larger budget than the 1 s default keeps the check
					// stable on a loaded test machine.
					{ timeout: 5000 },
				)
			},
		)

		it("keeps no Run/Deny when the masked command ask is already answered", async () => {
			const { queryByText, getAllByTestId } = renderChatView()

			await act(async () => {
				hydrateState([task, commandAsk(2, true), say("command_output", 3)])
			})
			await settle(getAllByTestId)

			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		it("keeps no Run/Deny when api_req_started supersedes the masked command ask", async () => {
			const { queryByText, getAllByTestId } = renderChatView()

			await act(async () => {
				hydrateState([task, commandAsk(2), say("api_req_started", 3)])
			})
			await settle(getAllByTestId)

			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		it("shows the newest unanswered command ask, not an older answered one", async () => {
			const { queryByText } = renderChatView()

			await act(async () => {
				hydrateState([task, commandAsk(2, true), commandAsk(3), say("command_output", 4)])
			})

			await waitFor(
				() => {
					expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument()
					expect(queryByText(DENY_BUTTON_LABEL)).toBeInTheDocument()
				},
				// A larger budget than the 1 s default keeps the check
				// stable on a loaded test machine.
				{ timeout: 5000 },
			)
		})

		it("keeps no Run/Deny when the newest masked command ask is answered", async () => {
			const { queryByText, getAllByTestId } = renderChatView()

			await act(async () => {
				hydrateState([task, commandAsk(2), commandAsk(3, true), say("command_output", 4)])
			})
			await settle(getAllByTestId)

			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		it("keeps no Run/Deny when a newer command_output ask supersedes the masked command ask", async () => {
			const { queryByText, getAllByTestId } = renderChatView()

			await act(async () => {
				hydrateState([
					task,
					commandAsk(2),
					{ type: "ask", ask: "command_output", ts: 3, text: "", partial: false },
					say("text", 4),
				])
			})
			await settle(getAllByTestId)

			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		it("does not re-show Run/Deny after the user answers the masked ask and output streams", async () => {
			const { getByText, queryByText, getAllByTestId } = renderChatView()

			await act(async () => {
				hydrateState([task, commandAsk(2), say("command_output", 3, true)])
			})
			await waitFor(() => expect(getByText(RUN_BUTTON_LABEL)).toBeInTheDocument(), { timeout: 5000 })

			await act(async () => {
				fireEvent.click(getByText(RUN_BUTTON_LABEL))
			})

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "askResponse", askResponse: "yesButtonClicked" }),
			)
			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()

			await act(async () => {
				hydrateState([task, commandAsk(2), say("command_output", 3, true), say("command_output", 4, true)])
			})
			await settle(getAllByTestId)

			expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
			expect(queryByText(DENY_BUTTON_LABEL)).not.toBeInTheDocument()
		})

		// Property test from the AskPresentation.tla invariant sentences:
		// F1 a masked pending command ask shows Run, F2 an answered ask never
		// does, F3 an api_req_started supersedes. The mirror below is the
		// derivation the fixed code implements.
		// The suite renders 32 snapshot shapes, so give it a larger budget
		// than the 5 s default.
		it("matches the derivation for every generated snapshot shape", async () => {
			const deriveRunButton = (msgs: ClineMessage[]): boolean => {
				const last = msgs.at(-1)
				if (!last) {
					return false
				}
				if (last.type === "ask") {
					return last.ask === "command" && last.isAnswered !== true
				}
				if (last.say === "api_req_started") {
					return false
				}
				for (let i = msgs.length - 1; i >= 0; i--) {
					const message = msgs[i]
					if (message.type === "ask") {
						return message.ask === "command" && message.isAnswered !== true && message.partial !== true
					}
					if (message.type === "say" && message.say === "api_req_started") {
						return false
					}
				}
				return false
			}

			// Each prefix models the messages before the snapshot tail. A
			// command_output ask cannot stand alone: it always follows the
			// command ask it resolves, so the last prefix pairs it with one.
			const prefixes: ClineMessage[][] = [
				[task, say("text", 2)],
				[task, commandAsk(2)],
				[task, commandAsk(2, true)],
				[task, commandAsk(2), { type: "ask", ask: "command_output", ts: 3, text: "", partial: false }],
			]
			const tails: ClineMessage[] = [
				say("command_output", 3),
				say("command_output", 3, true),
				say("text", 3),
				say("error", 3),
				say("api_req_started", 3),
				commandAsk(3),
				commandAsk(3, true),
			]

			for (const prefix of prefixes) {
				for (const tail of tails) {
					const messages = [...prefix, tail]
					const { queryByText, getAllByTestId, unmount } = renderChatView()

					await act(async () => {
						hydrateState(messages)
					})
					await settle(getAllByTestId)

					const expected = deriveRunButton(messages)
					// The presence check waits, so a slow render cannot make a
					// true shape read as false. The absence check runs after the
					// settle step, so it cannot read a false shape as true.
					if (expected) {
						await waitFor(() => expect(queryByText(RUN_BUTTON_LABEL)).toBeInTheDocument(), {
							timeout: 5000,
						})
					} else {
						expect(queryByText(RUN_BUTTON_LABEL)).not.toBeInTheDocument()
					}
					unmount()
				}
			}
		}, 60000)
	})

	describe("approval feedback segments", () => {
		const typed = async (input: HTMLElement) => {
			fireEvent.input(input, { target: { value: "use @/ok" } })
		}
		// The extension fills the box with text that has no user segments.
		const generated = async () => {
			window.postMessage({ type: "invoke", invoke: "setChatBoxMessage", text: "ctx @/secret" }, "*")
		}

		it.each([
			{ ask: "command", button: RUN_BUTTON_LABEL, askResponse: "yesButtonClicked" },
			{ ask: "command", button: DENY_BUTTON_LABEL, askResponse: "noButtonClicked" },
			{ ask: "resume_task", button: RESUME_BUTTON_LABEL, askResponse: "yesButtonClicked" },
		])("sends user segments for typed text with $ask $askResponse", async ({ ask, button, askResponse }) => {
			const { getByText, getByRole } = renderChatView()

			await act(async () => {
				hydrateState(askMessages(ask))
			})
			await waitFor(() => expect(getByText(button)).toBeInTheDocument())

			await act(async () => {
				await typed(getByRole("textbox"))
			})
			await act(async () => {
				fireEvent.click(getByText(button))
			})

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse,
					text: "use @/ok",
					segments: [{ text: "use @/ok", source: "user" }],
				}),
			)
		})

		it.each([
			{ ask: "command", button: RUN_BUTTON_LABEL, askResponse: "yesButtonClicked" },
			{ ask: "command", button: DENY_BUTTON_LABEL, askResponse: "noButtonClicked" },
			{ ask: "resume_task", button: RESUME_BUTTON_LABEL, askResponse: "yesButtonClicked" },
		])("keeps generated text generated with $ask $askResponse", async ({ ask, button, askResponse }) => {
			const { getByText, getByRole } = renderChatView()

			await act(async () => {
				hydrateState(askMessages(ask))
			})
			await waitFor(() => expect(getByText(button)).toBeInTheDocument())

			await act(async () => {
				await generated()
			})
			await waitFor(() => expect(getByRole("textbox")).toHaveValue("ctx @/secret"))
			await act(async () => {
				fireEvent.click(getByText(button))
			})

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse,
					text: "ctx @/secret",
					segments: [{ text: "ctx @/secret", source: "generated" }],
				}),
			)
		})

		it("keeps generated text generated after the user deletes it and undoes", async () => {
			const { getByText, getByRole } = renderChatView()

			await act(async () => {
				hydrateState(askMessages("command"))
			})
			await waitFor(() => expect(getByText(RUN_BUTTON_LABEL)).toBeInTheDocument())

			await act(async () => {
				await generated()
			})
			await waitFor(() => expect(getByRole("textbox")).toHaveValue("ctx @/secret"))
			await act(async () => {
				fireEvent.input(getByRole("textbox"), { target: { value: "" }, inputType: "deleteContentBackward" })
			})
			await act(async () => {
				fireEvent.input(getByRole("textbox"), {
					target: { value: "ctx @/secret" },
					inputType: "historyUndo",
				})
			})
			await act(async () => {
				fireEvent.click(getByText(RUN_BUTTON_LABEL))
			})

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					text: "ctx @/secret",
					segments: [{ text: "ctx @/secret", source: "generated" }],
				}),
			)
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
