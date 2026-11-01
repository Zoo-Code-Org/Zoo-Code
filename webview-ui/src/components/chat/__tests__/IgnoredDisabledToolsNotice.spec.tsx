import React from "react"

import { renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@roo-code/types"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const map: Record<string, string> = {
				"chat:ignoredDisabledTools.title": "Disabled tool ignored",
				"chat:ignoredDisabledTools.messageTemplate":
					"The following tools cannot be disabled, so their disabledTools entries were ignored: {{tools}}.",
			}
			const template = map[key] ?? key
			if (!options) return template
			return template.replace("{{tools}}", String(options.tools))
		},
		i18n: {
			exists: () => false,
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

function renderChatRow(message: ClineMessage) {
	return renderWithExtensionState(
		<ChatRowContent
			message={message}
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
}

describe("ChatRow - ignored disabled-tools notice", () => {
	it("renders a warning row naming the ignored tool entry", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
			text: JSON.stringify({ ignoredTools: ["attempt_completion"] }),
		}

		renderChatRow(message)

		expect(screen.getByText("Disabled tool ignored")).toBeInTheDocument()
		expect(
			screen.getByText(
				"The following tools cannot be disabled, so their disabledTools entries were ignored: attempt_completion.",
			),
		).toBeInTheDocument()
	})

	it("keeps the {{tools}} placeholder in every locale and never claims availability in en", () => {
		// The react-i18next mock above hides the real strings, so read the locale files directly.
		// A model profile's excludedTools can still strip the tool, so the copy must not promise it.
		const locales = import.meta.glob<{ ignoredDisabledTools: { messageTemplate: string } }>(
			"../../../i18n/locales/*/chat.json",
			{ eager: true, import: "default" },
		)
		const entries = Object.entries(locales)
		expect(entries.length).toBeGreaterThan(1)
		const missing = entries
			.filter(([, chat]) => !chat.ignoredDisabledTools.messageTemplate.includes("{{tools}}"))
			.map(([path]) => path)
		expect(missing).toEqual([])
		const en = locales["../../../i18n/locales/en/chat.json"]
		expect(en.ignoredDisabledTools.messageTemplate).not.toMatch(/available/i)
	})

	it("renders nothing when the notice message text is missing", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
		}

		const { container } = renderChatRow(message)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Disabled tool ignored")).not.toBeInTheDocument()
	})

	it("renders nothing when the notice payload is not valid JSON", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
			text: "{not valid json",
		}

		const { container } = renderChatRow(message)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Disabled tool ignored")).not.toBeInTheDocument()
	})

	it("renders nothing when ignoredTools is a non-array string", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
			text: JSON.stringify({ ignoredTools: "attempt_completion" }),
		}

		const { container } = renderChatRow(message)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Disabled tool ignored")).not.toBeInTheDocument()
	})

	it("renders nothing when ignoredTools is an empty array", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
			text: JSON.stringify({ ignoredTools: [] }),
		}

		const { container } = renderChatRow(message)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Disabled tool ignored")).not.toBeInTheDocument()
	})

	it("renders nothing when ignoredTools contains a non-string entry", () => {
		const message: ClineMessage = {
			type: "say",
			say: "ignored_disabled_tools_warning",
			ts: Date.now(),
			text: JSON.stringify({ ignoredTools: ["attempt_completion", 42] }),
		}

		const { container } = renderChatRow(message)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Disabled tool ignored")).not.toBeInTheDocument()
	})
})
