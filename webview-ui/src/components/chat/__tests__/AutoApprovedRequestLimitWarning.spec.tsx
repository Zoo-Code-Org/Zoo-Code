import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"
import type { ClineMessage } from "@roo-code/types"
import { AutoApprovedRequestLimitWarning } from "../AutoApprovedRequestLimitWarning"

// Mock vscode messaging
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock react-i18next
vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, any> }) => (
		<span data-i18n={i18nKey}>
			{i18nKey}
			{values?.count ? `:${values.count}` : ""}
		</span>
	),
}))

// Mock i18n TranslationContext
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("AutoApprovedRequestLimitWarning", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders token limit warning when type is tokens", () => {
		const message: ClineMessage = {
			ts: 1000,
			type: "ask",
			ask: "auto_approval_max_req_reached",
			text: JSON.stringify({ count: "50,000", type: "tokens" }),
		}

		render(<AutoApprovedRequestLimitWarning message={message} />)

		expect(screen.getByText("ask.autoApprovedTokenLimitReached.title")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedTokenLimitReached.description:50,000")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedTokenLimitReached.button")).toBeInTheDocument()
	})

	it("renders cost limit warning when type is cost", () => {
		const message: ClineMessage = {
			ts: 1000,
			type: "ask",
			ask: "auto_approval_max_req_reached",
			text: JSON.stringify({ count: "5.00", type: "cost" }),
		}

		render(<AutoApprovedRequestLimitWarning message={message} />)

		expect(screen.getByText("ask.autoApprovedCostLimitReached.title")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedCostLimitReached.description:5.00")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedCostLimitReached.button")).toBeInTheDocument()
	})

	it("renders request limit warning when type is requests or omitted", () => {
		const message: ClineMessage = {
			ts: 1000,
			type: "ask",
			ask: "auto_approval_max_req_reached",
			text: JSON.stringify({ count: 20 }),
		}

		render(<AutoApprovedRequestLimitWarning message={message} />)

		expect(screen.getByText("ask.autoApprovedRequestLimitReached.title")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedRequestLimitReached.description:20")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedRequestLimitReached.button")).toBeInTheDocument()
	})

	it("posts yesButtonClicked message when button is clicked", () => {
		const message: ClineMessage = {
			ts: 1000,
			type: "ask",
			ask: "auto_approval_max_req_reached",
			text: JSON.stringify({ count: "50,000", type: "tokens" }),
		}

		render(<AutoApprovedRequestLimitWarning message={message} />)

		const button = screen.getByRole("button")
		fireEvent.click(button)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "askResponse",
			askResponse: "yesButtonClicked",
		})
	})
})

