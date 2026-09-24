import React from "react"

import { renderWithExtensionState, screen } from "@/utils/test-utils"
import enChat from "@src/i18n/locales/en/chat.json"
import { ChatRowContent } from "../ChatRow"

// Keys resolve against the real English bundle rather than echoing back, so the test
// fails if the copy stops naming the setting the user has to change.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const [, dotted] = key.split(":")
			const resolved = dotted
				?.split(".")
				.reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], enChat)
			return typeof resolved === "string" ? resolved : key
		},
		i18n: { exists: () => false },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

function renderErrorRow(text: string) {
	return renderWithExtensionState(
		<ChatRowContent
			message={{ type: "say", say: "error", ts: Date.now(), text } as never}
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

describe("ChatRow - output token cap", () => {
	it("names the token limit and the setting instead of blaming the API", () => {
		renderErrorRow("MODEL_OUTPUT_TOKEN_CAP")

		expect(screen.getByText(enChat.modelResponseIncomplete)).toBeInTheDocument()
		expect(screen.getByText(enChat.modelResponseErrors.outputTokenCap)).toBeInTheDocument()
		// The generic copy would blame the provider for a limit the user can raise.
		expect(screen.queryByText(enChat.modelResponseErrors.noAssistantMessages)).toBeNull()
	})

	it("offers the static explanation as the error details", () => {
		renderErrorRow("MODEL_OUTPUT_TOKEN_CAP")

		expect(screen.getByText(enChat.errorDetails.link)).toBeInTheDocument()
	})

	it("still renders the generic empty-response row for the other marker", () => {
		// Keeps the new branch from swallowing the case it was carved out of.
		renderErrorRow("MODEL_NO_ASSISTANT_MESSAGES")

		expect(screen.getByText(enChat.modelResponseErrors.noAssistantMessages)).toBeInTheDocument()
		expect(screen.queryByText(enChat.modelResponseErrors.outputTokenCap)).toBeNull()
	})
})
