import React from "react"
import { render, screen } from "@/utils/test-utils"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
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

const queryClient = new QueryClient()

const mockOnToggleExpand = vi.fn()
const mockOnSuggestionClick = vi.fn()
const mockOnBatchFileResponse = vi.fn()
const mockOnFollowUpUnmount = vi.fn()

const renderChatRowWithProviders = (message: any) => {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
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
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - fetchWebContent tool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should display fetchWebContent ask message with URL", () => {
		const message: any = {
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
		const message: any = {
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
		const message: any = {
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
		const message: any = {
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
})
