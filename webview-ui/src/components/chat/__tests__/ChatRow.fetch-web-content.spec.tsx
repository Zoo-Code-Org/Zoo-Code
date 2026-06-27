import React from "react"
import { renderWithExtensionState, screen, waitFor } from "@/utils/test-utils"
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ClineMessage } from "@roo-code/types"
import { ChatRowContent } from "../ChatRow"

// Mock i18n. ChatRow reads `t` from the app translation context.
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:webFetch.wantsToFetch": "Zoo wants to fetch web content",
				"chat:webFetch.didFetch": "Zoo fetched web content",
			}
			return translations[key] || key
		},
		language: "en",
	}),
}))

vi.mock("react-i18next", () => ({
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

	const fetchMessage = (type: "ask" | "say", url: string): ClineMessage =>
		type === "ask"
			? {
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "fetchWebContent", url }),
					partial: false,
				}
			: {
					type: "say",
					say: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "fetchWebContent", url }),
					partial: false,
				}

	it.each([
		{ type: "ask" as const, title: "Zoo wants to fetch web content" },
		{ type: "say" as const, title: "Zoo fetched web content" },
	])("$type row: hides the decorative Globe icon from screen readers", ({ type }) => {
		const { container } = renderChatRowWithProviders(fetchMessage(type, "https://docs.example.com/api"))

		expect(screen.queryByLabelText("Web fetch icon")).not.toBeInTheDocument()
		const icon = container.querySelector("svg")
		expect(icon).toHaveAttribute("aria-hidden", "true")
		expect(icon).not.toHaveAttribute("aria-label")
	})

	it.each([
		{ type: "ask" as const, title: "Zoo wants to fetch web content" },
		{ type: "say" as const, title: "Zoo fetched web content" },
	])("$type row: announces the row through a polite live region", async ({ type, title }) => {
		const url = "https://docs.example.com/api"
		renderChatRowWithProviders(fetchMessage(type, url))

		const status = screen.getByRole("status")
		expect(status).toHaveAttribute("aria-live", "polite")
		expect(status).toHaveAttribute("aria-atomic", "true")
		await waitFor(() => expect(status).toHaveTextContent(`${title}: ${url}`))
	})

	it.each(["ask" as const, "say" as const])(
		"%s row: shows the full URL wrapped and selectable, never truncated",
		(type) => {
			const url = `https://www.bbc.com.${"a".repeat(200)}.attacker.example/path`
			renderChatRowWithProviders(fetchMessage(type, url))

			const urlEl = screen.getByTestId("fetch-url")
			expect(urlEl).toHaveTextContent(url)
			expect(urlEl).toHaveClass("break-all", "whitespace-normal", "select-text")
			expect(urlEl).not.toHaveClass("text-ellipsis")
			expect(urlEl).not.toHaveClass("whitespace-nowrap")
			expect(urlEl).not.toHaveClass("overflow-hidden")
			// The header's default `select-none` must be overridden.
			const header = urlEl.parentElement
			expect(header).toHaveClass("select-text")
			expect(header).not.toHaveClass("select-none")
		},
	)

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
		expect(screen.getByTestId("fetch-url")).toHaveTextContent("https://example.com/completed")
	})
})
