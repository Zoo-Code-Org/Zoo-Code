import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@roo-code/types"

import { ChatRowContent } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => true } }),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// The edit box is a large component of its own. This stand-in shows the text it was given and offers the two ways
// out of editing, which is all the timestamp tests need.
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: ({
		inputValue,
		onSend,
		onCancel,
	}: {
		inputValue: string
		onSend: () => void
		onCancel: () => void
	}) => (
		<div data-testid="edit-box">
			<textarea data-testid="edit-text" value={inputValue} readOnly />
			<button data-testid="cancel-edit" onClick={onCancel} />
			<button data-testid="send-edit" onClick={onSend} />
		</div>
	),
}))

let mockState: Record<string, unknown> = {}
vi.mock("@src/context/ExtensionStateContext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@src/context/ExtensionStateContext")>()),
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [],
		currentTaskItem: undefined,
		...mockState,
	}),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const renderRow = (message: ClineMessage, isStreaming = false) =>
	render(
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

describe("ChatRow – message timestamp", () => {
	beforeEach(() => {
		mockState = {}
	})

	it("shows when a user message was sent", () => {
		renderRow({ ts: Date.now(), type: "say", say: "user_feedback", text: "hello there" })
		expect(screen.getByTestId("message-timestamp").textContent).toContain("Today")
	})

	it("uses the message's own timestamp, not the current time", () => {
		const d = new Date()
		d.setDate(d.getDate() - 1)
		d.setHours(11, 43, 0, 0)
		renderRow({ ts: d.getTime(), type: "say", say: "user_feedback", text: "an older message" })
		expect(screen.getByTestId("message-timestamp").textContent).toContain("Yesterday")
	})

	it("is rendered after the message bubble (under it), not before", () => {
		const { container } = renderRow({ ts: Date.now(), type: "say", say: "user_feedback", text: "ordering" })
		const html = container.innerHTML
		expect(html.indexOf("ordering")).toBeGreaterThan(-1)
		expect(html.indexOf("message-timestamp")).toBeGreaterThan(html.indexOf("ordering"))
	})

	it("applies the user's time and date format settings", () => {
		const d = new Date()
		d.setHours(14, 41, 0, 0)
		mockState = { timeFormat: "24h", dateFormat: "ymd" }
		renderRow({ ts: d.getTime(), type: "say", say: "user_feedback", text: "formats" })
		expect(screen.getByTestId("message-timestamp").textContent).toContain("14:41")
	})

	describe("assistant text", () => {
		it("shows when the reply was sent, under the reply", () => {
			const { container } = renderRow({ ts: Date.now(), type: "say", say: "text", text: "assistant reply" })
			expect(screen.getByTestId("message-timestamp").textContent).toContain("Today")
			const html = container.innerHTML
			expect(html.indexOf("message-timestamp")).toBeGreaterThan(html.indexOf("assistant reply"))
		})

		it("uses the reply's own timestamp and the user's formats", () => {
			const d = new Date()
			d.setHours(14, 41, 0, 0)
			mockState = { timeFormat: "24h", dateFormat: "ymd" }
			renderRow({ ts: d.getTime(), type: "say", say: "text", text: "formatted reply" })
			expect(screen.getByTestId("message-timestamp").textContent).toContain("14:41")
		})

		it("waits until the reply has finished streaming", () => {
			const { rerender } = renderRow({
				ts: Date.now(),
				type: "say",
				say: "text",
				text: "still typing",
				partial: true,
			})
			expect(screen.queryByTestId("message-timestamp")).toBeNull()

			rerender(
				<ChatRowContent
					message={{ ts: Date.now(), type: "say", say: "text", text: "still typing", partial: false }}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
					onBatchFileResponse={() => {}}
					onFollowUpUnmount={() => {}}
					isFollowUpAnswered={false}
				/>,
			)
			expect(screen.getByTestId("message-timestamp")).toBeTruthy()
		})

		it("shows the time of a finished completion result, and waits while it streams", () => {
			const { rerender } = renderRow({
				ts: Date.now(),
				type: "say",
				say: "completion_result",
				text: "all done",
				partial: true,
			})
			expect(screen.queryByTestId("message-timestamp")).toBeNull()

			rerender(
				<ChatRowContent
					message={{
						ts: Date.now(),
						type: "say",
						say: "completion_result",
						text: "all done",
						partial: false,
					}}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
					onBatchFileResponse={() => {}}
					onFollowUpUnmount={() => {}}
					isFollowUpAnswered={false}
				/>,
			)
			expect(screen.getByTestId("message-timestamp").textContent).toContain("Today")
		})

		it("shows nothing for an assistant message with an invalid timestamp", () => {
			renderRow({ ts: 0, type: "say", say: "text", text: "no time" })
			expect(screen.queryByTestId("message-timestamp")).toBeNull()
		})
	})

	describe("an invalid timestamp leaves no empty block (and so no extra gap) under the message", () => {
		const rows: [string, Partial<ClineMessage>][] = [
			["a user message", { say: "user_feedback", text: "hello there" }],
			["an assistant reply", { say: "text", text: "the reply" }],
			["a completion result", { say: "completion_result", text: "all done" }],
		]

		const wrappers = (container: HTMLElement) => container.querySelectorAll(".ml-6.mt-1").length

		it.each(rows)("%s", (_name, row) => {
			const valid = renderRow({ ts: Date.now(), type: "say", ...row } as ClineMessage)
			const withTime = wrappers(valid.container)
			valid.unmount()

			const invalid = renderRow({ ts: 0, type: "say", ...row } as ClineMessage)

			expect(screen.queryByTestId("message-timestamp")).toBeNull()
			expect(wrappers(invalid.container)).toBe(withTime - 1)
		})
	})

	describe("date format on an older message, for every row that shows a time", () => {
		// Years back, so the date (not "Today" or a weekday) is shown, whatever day the tests run.
		const OLD = new Date(2024, 2, 7, 14, 41, 0, 0).getTime()

		const rows: Array<[string, ClineMessage]> = [
			["a user message", { ts: OLD, type: "say", say: "user_feedback", text: "u" }],
			["an assistant reply", { ts: OLD, type: "say", say: "text", text: "a", partial: false }],
			["a completion result", { ts: OLD, type: "say", say: "completion_result", text: "c", partial: false }],
		]
		const formats: Array<{ settings: Record<string, string>; date: string; time: RegExp }> = [
			{ settings: { dateFormat: "ymd", timeFormat: "24h" }, date: "2024-03-07", time: /14:41/ },
			{ settings: { dateFormat: "dmy", timeFormat: "12h" }, date: "07/03/2024", time: /2:41\s?PM/i },
			{ settings: { dateFormat: "mdy", timeFormat: "24h" }, date: "03/07/2024", time: /14:41/ },
		]

		describe.each(rows)("%s", (_name, message) => {
			it.each(formats)("writes the date as $date when the date format is $settings.dateFormat", (format) => {
				mockState = format.settings
				renderRow(message)

				const text = screen.getByTestId("message-timestamp").textContent!
				expect(text).toContain(format.date)
				expect(text).toMatch(format.time)
				// Not a relative day: an old message is dated.
				expect(text).not.toMatch(/Today|Yesterday/)
			})

			it("uses the locale's own short date when the date format is automatic", () => {
				mockState = { dateFormat: "auto", timeFormat: "24h" }
				renderRow(message)

				const text = screen.getByTestId("message-timestamp").textContent!
				expect(text).toContain("Mar 7, 2024")
				expect(text).toContain("14:41")
			})

			it("writes the automatic date in the display language, not only in English", async () => {
				const i18next = (await import("i18next")).default
				const original = i18next.language
				i18next.language = "de"
				try {
					mockState = { dateFormat: "auto", timeFormat: "24h" }
					renderRow(message)

					const text = screen.getByTestId("message-timestamp").textContent!
					expect(text).toContain("7. März 2024")
					expect(text).toContain("14:41")
					expect(text).not.toContain("Mar")
				} finally {
					i18next.language = original
				}
			})

			it("carries the exact time as a machine-readable value", () => {
				mockState = { dateFormat: "ymd", timeFormat: "24h" }
				renderRow(message)

				expect(screen.getByTestId("message-timestamp")).toHaveAttribute("datetime", new Date(OLD).toISOString())
			})
		})
	})

	describe("while a user message is being edited", () => {
		const message: ClineMessage = { ts: Date.now(), type: "say", say: "user_feedback", text: "an editable message" }
		const startEditing = () => fireEvent.click(screen.getByText("an editable message"))

		it("shows the time before editing starts", () => {
			renderRow(message)

			expect(screen.getByTestId("message-timestamp")).toBeInTheDocument()
			expect(screen.queryByTestId("edit-box")).not.toBeInTheDocument()
		})

		it("keeps the message in the edit box and hides the time, which the edit box replaces", () => {
			renderRow(message)

			startEditing()

			expect(screen.getByTestId("edit-box")).toBeInTheDocument()
			expect(screen.getByTestId("edit-text")).toHaveValue("an editable message")
			expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument()
		})

		it("shows the time again, under the message, when editing is cancelled", () => {
			renderRow(message)
			startEditing()

			fireEvent.click(screen.getByTestId("cancel-edit"))

			expect(screen.queryByTestId("edit-box")).not.toBeInTheDocument()
			expect(screen.getByText("an editable message")).toBeInTheDocument()
			expect(screen.getByTestId("message-timestamp")).toBeInTheDocument()
		})

		it("shows the time again when the edit is sent", () => {
			renderRow(message)
			startEditing()

			fireEvent.click(screen.getByTestId("send-edit"))

			expect(screen.queryByTestId("edit-box")).not.toBeInTheDocument()
			expect(screen.getByTestId("message-timestamp")).toBeInTheDocument()
		})

		it("cannot be edited while streaming, so the time stays", () => {
			renderRow(message, true)

			startEditing()

			expect(screen.queryByTestId("edit-box")).not.toBeInTheDocument()
			expect(screen.getByTestId("message-timestamp")).toBeInTheDocument()
		})
	})

	it("keeps the message visible while streaming", () => {
		renderRow({ ts: Date.now(), type: "say", say: "user_feedback", text: "streaming" }, true)
		expect(screen.getByTestId("message-timestamp")).toBeTruthy()
	})
})
