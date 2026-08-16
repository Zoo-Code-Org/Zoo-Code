import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"
import type { ClineMessage } from "@roo-code/types"

// Mock vscode API
const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

// Mock i18n — the two inline-subtask banner titles plus a fallback to the key itself.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const map: Record<string, string> = {
				"chat:subtasks.inlineStarted": "Subtask flattened to inline",
				"chat:subtasks.inlineRejected": "Nested subtask rejected",
				"chat:subtasks.inlineConfigure": "Adjust task tree settings",
				"chat:subtasks.inlineStartedDetail":
					"Nesting limit {{maxDepth}} reached — subtask flattened and executing inline in this conversation.",
				"chat:subtasks.inlineRejectedLimitDetail":
					"Nesting limit {{maxDepth}} reached and auto-flatten is disabled. Continue working directly in the current conversation instead of delegating.",
				"chat:subtasks.inlineRejectedNestedDetail":
					"Cannot start a nested subtask while an inline subtask is already in progress. Complete the current inline subtask with attempt_completion first.",
			}
			const raw = map[key] ?? key
			if (!options) return raw
			// Substitute {{var}} placeholders from the options object.
			return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? `{{${name}}}`))
		},
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [] as ClineMessage[],
		currentTaskItem: undefined,
	}),
}))

// Mock useSelectedModel hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

function renderChatRow(message: ClineMessage) {
	return render(
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

describe("ChatRow - inline subtask banners", () => {
	it("renders a distinct banner when a subtask is auto-flattened to inline", () => {
		const message: ClineMessage = {
			ts: Date.now(),
			type: "say" as const,
			say: "inline_subtask_started" as const,
			text: JSON.stringify({ maxDepth: 2 }),
		}

		renderChatRow(message)

		// Banner title (i18n) is present…
		expect(screen.getByText("Subtask flattened to inline")).toBeInTheDocument()
		// …and the localized detail text renders below it.
		expect(
			screen.getByText("Nesting limit 2 reached — subtask flattened and executing inline in this conversation."),
		).toBeInTheDocument()
	})

	it.each([
		[
			"nested",
			JSON.stringify({ reason: "nested" }),
			"Cannot start a nested subtask while an inline subtask is already in progress. Complete the current inline subtask with attempt_completion first.",
		],
		[
			"limit",
			JSON.stringify({ reason: "limit", maxDepth: 2 }),
			"Nesting limit 2 reached and auto-flatten is disabled. Continue working directly in the current conversation instead of delegating.",
		],
	] as const)("renders a distinct banner when a new_task is rejected (%s)", (_reason, text, detail) => {
		const message: ClineMessage = {
			ts: Date.now(),
			type: "say" as const,
			say: "inline_subtask_rejected" as const,
			text,
		}

		renderChatRow(message)

		expect(screen.getByText("Nested subtask rejected")).toBeInTheDocument()
		expect(screen.getByText(detail)).toBeInTheDocument()
	})

	describe("settings hint link", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		it.each(["inline_subtask_started", "inline_subtask_rejected"] as const)(
			"deep-links the %s banner into the task-tree settings section",
			(say) => {
				const message: ClineMessage = {
					ts: Date.now(),
					type: "say" as const,
					say,
					text: "detail",
				}

				renderChatRow(message)

				// The banner renders its settings-hint link…
				const link = screen.getByText("Adjust task tree settings")
				expect(link).toBeInTheDocument()
				// …and clicking it switches to the settings tab, deep-linked to contextManagement.
				fireEvent.click(link)
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "switchTab",
					tab: "settings",
					values: { section: "contextManagement" },
				})
			},
		)
	})

	it("does not render the banners for unrelated say types", () => {
		const message: ClineMessage = {
			ts: Date.now(),
			type: "say" as const,
			say: "text" as const,
			text: "ordinary model text",
		}

		renderChatRow(message)

		expect(screen.queryByText("Subtask flattened to inline")).not.toBeInTheDocument()
		expect(screen.queryByText("Nested subtask rejected")).not.toBeInTheDocument()
	})
})
