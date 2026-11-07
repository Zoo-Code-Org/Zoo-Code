import React from "react"
import { renderWithExtensionState, screen } from "@/utils/test-utils"
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ClineMessage } from "@roo-code/types"
import { ChatRowContent } from "../ChatRow"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:webFetch.wantsToFetch": "Zoo wants to fetch web content",
				"chat:webFetch.didFetch": "Zoo fetched web content",
			}
			return translations[key] || key
		},
	}),
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => {
		return <>{children || i18nKey}</>
	},
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

// Mock VSCodeBadge
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children, ...props }: { children: React.ReactNode }) => <span {...props}>{children}</span>,
}))

const mockOnToggleExpand = vi.fn()
const mockOnSuggestionClick = vi.fn()
const mockOnBatchFileResponse = vi.fn()
const mockOnFollowUpUnmount = vi.fn()

const renderChatRowWithProviders = (message: ClineMessage) => {
	return renderWithExtensionState(
		<ChatRowContent
			message={message}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={mockOnToggleExpand}
			onSuggestionClick={mockOnSuggestionClick}
			onBatchFileResponse={mockOnBatchFileResponse}
			onFollowUpUnmount={mockOnFollowUpUnmount}
			isFollowUpAnswered={false}
		/>,
	)
}

describe("ChatRow - fetchWebContent tool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should display fetchWebContent ask message with URL", () => {
		const message: ClineMessage = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "fetchWebContent",
				url: "https://example.com",
			}),
			partial: false,
		}

		renderChatRowWithProviders(message)

		expect(screen.getByText("Zoo wants to fetch web content")).toBeInTheDocument()
		expect(screen.getByText("https://example.com")).toBeInTheDocument()
	})

	it("should display the Globe icon for fetchWebContent", () => {
		const message: ClineMessage = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "fetchWebContent",
				url: "https://docs.example.com/api",
			}),
			partial: false,
		}

		renderChatRowWithProviders(message)

		expect(screen.getByLabelText("Web fetch icon")).toBeInTheDocument()
	})

	it("should display the URL in the tool use block", () => {
		const message: ClineMessage = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "fetchWebContent",
				url: "https://api.github.com/repos/owner/repo",
			}),
			partial: false,
		}

		renderChatRowWithProviders(message)

		expect(screen.getByText("https://api.github.com/repos/owner/repo")).toBeInTheDocument()
	})

	it("should not return null for fetchWebContent tool (regression test)", () => {
		const message: ClineMessage = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "fetchWebContent",
				url: "https://www.delfi.lt",
			}),
			partial: false,
		}

		const { container } = renderChatRowWithProviders(message)

		// The container should have rendered content (not null)
		expect(container.innerHTML).not.toBe("")
		expect(screen.getByText("Zoo wants to fetch web content")).toBeInTheDocument()
		expect(screen.getByText("https://www.delfi.lt")).toBeInTheDocument()
	})

	it("should display the completed fetchWebContent say/tool message with didFetch text and URL", () => {
		const message: ClineMessage = {
			type: "say",
			say: "tool",
			ts: Date.now(),
			text: JSON.stringify({
				tool: "fetchWebContent",
				url: "https://example.com/completed",
			}),
			partial: false,
		}

		const { container } = renderChatRowWithProviders(message)

		// The container should have rendered content (not null)
		expect(container.innerHTML).not.toBe("")
		expect(screen.getByText("Zoo fetched web content")).toBeInTheDocument()
		expect(screen.getByText("https://example.com/completed")).toBeInTheDocument()
		expect(screen.getByLabelText("Web fetch icon")).toBeInTheDocument()
	})
})
