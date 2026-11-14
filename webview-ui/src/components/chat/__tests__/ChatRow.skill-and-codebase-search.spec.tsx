import React from "react"
import { renderWithExtensionState, screen } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:skill.wantsToLoad": "Roo wants to load a skill",
				"chat:arguments": "Arguments",
				"chat:codebaseSearch.displayError": "Error displaying search results.",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock("@src/components/common/CodeBlock", () => ({
	default: () => null,
}))

const renderChatRow = (message: any, isExpanded = false) =>
	renderWithExtensionState(
		<ChatRowContent
			message={message}
			isExpanded={isExpanded}
			isLast={false}
			isStreaming={false}
			onToggleExpand={() => {}}
			onSuggestionClick={() => {}}
			onBatchFileResponse={() => {}}
			onFollowUpUnmount={() => {}}
			isFollowUpAnswered={false}
		/>,
	)

describe("ChatRow - skill and codebase search", () => {
	it("renders the translated arguments label for a skill with args", () => {
		const message = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "skill",
				skill: "my-skill",
				args: "some args",
				description: "A skill",
				source: "project",
			}),
			partial: false,
		}

		renderChatRow(message, true)

		expect(screen.getByText("Arguments")).toBeInTheDocument()
		expect(screen.getByText("some args")).toBeInTheDocument()
	})

	it("renders the translated error label for an invalid codebase search result", () => {
		const message = {
			type: "say",
			say: "codebase_search_result",
			ts: Date.now(),
			text: JSON.stringify({ notContent: true }),
			partial: false,
		}

		renderChatRow(message)

		expect(screen.getByText("Error displaying search results.")).toBeInTheDocument()
	})
})
