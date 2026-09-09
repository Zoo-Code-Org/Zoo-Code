import React from "react"

import { renderWithExtensionState, screen } from "@/utils/test-utils"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => <>{children || i18nKey}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

vi.mock("../CommandExecution", () => ({
	CommandExecution: ({ text, title, isDenied }: { text?: string; title?: React.ReactNode; isDenied?: boolean }) => (
		<div data-testid="command-execution" data-denied={isDenied ? "true" : "false"}>
			{title}
			{text}
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children, ...props }: { children: React.ReactNode }) => <span {...props}>{children}</span>,
}))

const renderCommand = (autoApprovalDecision?: "approve" | "deny") => {
	return renderWithExtensionState(
		<ChatRowContent
			message={{
				type: "ask",
				ask: "command",
				ts: 1,
				text: "rm -rf /tmp/example",
				autoApprovalDecision,
			}}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={vi.fn()}
			onSuggestionClick={vi.fn()}
			onBatchFileResponse={vi.fn()}
			onFollowUpUnmount={vi.fn()}
			isFollowUpAnswered={false}
		/>,
	)
}

describe("ChatRow - denied commands", () => {
	it("shows a denied status for a command rejected by auto-approval", () => {
		renderCommand("deny")

		expect(screen.getByText("chat:commandExecution.denied")).toBeInTheDocument()
		expect(screen.getByTestId("command-execution")).toHaveAttribute("data-denied", "true")
	})

	it("does not show a denied status for an approved command", () => {
		renderCommand("approve")

		expect(screen.queryByText("chat:commandExecution.denied")).not.toBeInTheDocument()
		expect(screen.getByTestId("command-execution")).toHaveAttribute("data-denied", "false")
	})

	it("does not show a denied status while a command awaits a decision", () => {
		renderCommand()

		expect(screen.queryByText("chat:commandExecution.denied")).not.toBeInTheDocument()
		expect(screen.getByTestId("command-execution")).toHaveAttribute("data-denied", "false")
	})
})
