import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ClineMessage } from "@roo-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"chat:fileOperations.wantsToEdit": "Roo wants to edit this file",
				"chat:fileOperations.wantsToEditProtected": "Roo wants to edit a protected file",
				"chat:fileOperations.wantsToEditOutsideWorkspace": "Roo wants to edit outside workspace",
				"chat:fileOperations.wantsToApplyBatchChanges": "Roo wants to apply batch changes",
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

const queryClient = new QueryClient()

function createToolAskMessage(toolPayload: Record<string, unknown>): ClineMessage {
	return {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		partial: false,
		text: JSON.stringify(toolPayload),
	}
}

function renderChatRow(message: ClineMessage, isExpanded = false) {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
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
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - inline diff stats and actions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockPostMessage.mockClear()
	})

	it("uses appliedDiff edit treatment (header/icon/diff stats)", () => {
		const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n"
		const message = createToolAskMessage({
			tool: "appliedDiff",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message, false)

		expect(screen.getByText("Roo wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("uses same edit treatment for editedExistingFile", () => {
		const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n"
		const message = createToolAskMessage({
			tool: "editedExistingFile",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Roo wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("uses same edit treatment for searchAndReplace", () => {
		const diff = "-a\n-b\n+c\n"
		const message = createToolAskMessage({
			tool: "searchAndReplace",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 2 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Roo wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-2")).toBeInTheDocument()
	})

	it("uses same edit treatment for newFileCreated", () => {
		const content = "a\nb\nc"
		const message = createToolAskMessage({
			tool: "newFileCreated",
			path: "src/new-file.ts",
			content,
			diffStats: { added: 3, removed: 0 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Roo wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+3")).toBeInTheDocument()
		expect(screen.getByText("-0")).toBeInTheDocument()
	})

	it.each([
		["appliedDiff", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["editedExistingFile", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["newFileCreated", "+new file"],
		["searchAndReplace", "-a\n-b\n+c\n"],
		["search_and_replace", "-a\n-b\n+c\n"],
		["search_replace", "-a\n-b\n+c\n"],
		["edit", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["edit_file", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["apply_patch", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["apply_diff", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
		["insertContent", "@@ -1,1 +1,1 @@\n-old\n+new\n"],
	])("shows jump-to-file affordance for %s", (tool, diff) => {
		const message = createToolAskMessage({
			tool,
			path: "src/file.ts",
			diff,
			lineNumber: 0,
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message)
		mockPostMessage.mockClear()
		const openFileIcon = container.querySelector(".codicon-link-external") as HTMLElement | null

		expect(openFileIcon).toBeInTheDocument()
		if (!openFileIcon) {
			throw new Error(`Expected external link icon for ${tool}`)
		}

		fireEvent.click(openFileIcon)

		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "./src/file.ts",
		})
	})

	it("does not show jump-to-file affordance when path is missing", () => {
		const message = createToolAskMessage({
			tool: "appliedDiff",
			diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message)
		expect(container.querySelector(".codicon-link-external")).not.toBeInTheDocument()
	})

	it("does not show jump-to-file affordance for non-file tools", () => {
		const message = createToolAskMessage({
			tool: "executeCommand",
			path: "src/file.ts",
			command: "echo hello",
			content: "hello",
		})

		const { container } = renderChatRow(message)
		expect(container.querySelector(".codicon-link-external")).not.toBeInTheDocument()
	})

	it("preserves protected and outside-workspace messaging in unified branch", () => {
		const outsideWorkspaceMessage = createToolAskMessage({
			tool: "searchAndReplace",
			path: "../outside/file.ts",
			diff: "-a\n+b\n",
			isOutsideWorkspace: true,
			diffStats: { added: 1, removed: 1 },
		})
		renderChatRow(outsideWorkspaceMessage)
		expect(screen.getByText("Roo wants to edit outside workspace")).toBeInTheDocument()

		const protectedMessage = createToolAskMessage({
			tool: "appliedDiff",
			path: "src/protected.ts",
			diff: "-a\n+b\n",
			isProtected: true,
			diffStats: { added: 1, removed: 1 },
		})
		const { container } = renderChatRow(protectedMessage)
		expect(screen.getByText("Roo wants to edit a protected file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-lock")).toBeInTheDocument()
	})

	it("keeps batch diff handling for unified edit tools", () => {
		const message = createToolAskMessage({
			tool: "searchAndReplace",
			batchDiffs: [
				{
					path: "src/a.ts",
					changeCount: 1,
					key: "a",
					content: "@@ -1,1 +1,1 @@\n-a\n+b\n",
					diffStats: { added: 1, removed: 1 },
				},
			],
		})

		renderChatRow(message)

		expect(screen.getByText("Roo wants to apply batch changes")).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
	})
})
