import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ClineMessage } from "@roo-code/types"
import { ChatRowContent } from "../ChatRow"

const mockPostMessage = vi.fn()
const mockOnToggleExpand = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, string>) => {
			const map: Record<string, string> = {
				"chat:compactTool.expandHint": "Click to expand",
				"chat:compactTool.label": opts?.tool ? `tool: ${opts.tool}` : "tool",
			}
			return map[key] || key
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock CodeBlock (avoid ESM/highlighter costs)
vi.mock("@src/components/common/CodeBlock", () => ({
	default: () => null,
}))

// Mock useExtensionState to enable compactToolUI
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: undefined,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [],
		currentTaskItem: undefined,
		compactToolUI: true,
	}),
	ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const queryClient = new QueryClient()

function createSayToolMessage(toolPayload: Record<string, unknown>): ClineMessage {
	return {
		type: "say",
		say: "tool" as any,
		ts: Date.now(),
		text: JSON.stringify(toolPayload),
	}
}

function renderChatRow(message: ClineMessage, isExpanded = false) {
	return render(
		<QueryClientProvider client={queryClient}>
			<ChatRowContent
				message={message}
				isExpanded={isExpanded}
				isLast={false}
				isStreaming={false}
				onToggleExpand={mockOnToggleExpand}
				onSuggestionClick={() => {}}
				onBatchFileResponse={() => {}}
				onFollowUpUnmount={() => {}}
				isFollowUpAnswered={false}
			/>
		</QueryClientProvider>,
	)
}

describe("ChatRow - compact tool UI", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockOnToggleExpand.mockClear()
	})

	it("renders the compact row when compactToolUI is true and not expanded", () => {
		const message = createSayToolMessage({ tool: "readFile", path: "src/file.ts" })
		renderChatRow(message, false)

		expect(screen.getByTestId("compact-tool-row")).toBeInTheDocument()
	})

	it("calls onToggleExpand when the compact row is clicked", () => {
		const message = createSayToolMessage({ tool: "readFile", path: "src/file.ts" })
		renderChatRow(message, false)

		fireEvent.click(screen.getByTestId("compact-tool-row"))

		expect(mockOnToggleExpand).toHaveBeenCalledWith(message.ts)
	})

	it("has aria-expanded=false on the compact button", () => {
		const message = createSayToolMessage({ tool: "readFile", path: "src/file.ts" })
		renderChatRow(message, false)

		expect(screen.getByTestId("compact-tool-row")).toHaveAttribute("aria-expanded", "false")
	})
})
