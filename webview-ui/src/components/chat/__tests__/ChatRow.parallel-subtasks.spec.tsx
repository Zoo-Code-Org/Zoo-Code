import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"
import type { ClineMessage, HistoryItem, ParallelSubtaskInfo } from "@roo-code/types"

const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			const map: Record<string, string> = {
				"chat:parallelSubtasks.title": "Parallel investigations",
				"chat:parallelSubtasks.progress": "{{completed}} of {{total}} complete",
				"chat:parallelSubtasks.status.queued": "Queued",
				"chat:parallelSubtasks.status.running": "Running",
				"chat:parallelSubtasks.status.completed": "Completed",
				"chat:parallelSubtasks.status.failed": "Failed",
				"chat:parallelSubtasks.status.aborted": "Aborted",
				"chat:parallelSubtasks.openReport": "Report",
				"chat:parallelSubtasks.openDebugLog": "JSON log",
				"chat:parallelSubtasks.goToTask": "Go to task",
				"chat:parallelSubtasks.noReport": "No report available yet",
				"chat:task.expand": "Expand task",
				"chat:task.collapse": "Collapse task",
			}
			let value = map[key] ?? key
			if (params) {
				for (const [k, v] of Object.entries(params)) {
					value = value.replaceAll(`{{${k}}}`, String(v))
				}
			}
			return value
		},
	}),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

let mockCurrentTaskItem: Partial<HistoryItem> | undefined = undefined

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [],
		currentTaskItem: mockCurrentTaskItem,
	}),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const subtasks: ParallelSubtaskInfo[] = [
	{
		taskId: "child-1",
		label: "Investigate parser",
		mode: "code",
		status: "completed",
		reportPath: "/ws/.zoocode/subtask-reports/parent/investigate-parser-child-1.md",
		summary: "3 call sites found",
	},
	{
		taskId: "child-2",
		label: "Check tests",
		mode: "debug",
		status: "running",
		startedAt: Date.now(),
	},
]

function sayMessage(rows: ParallelSubtaskInfo[], partial: boolean): ClineMessage {
	return {
		ts: 1000,
		type: "say",
		say: "tool",
		text: JSON.stringify({ tool: "parallelSubtasks", subtasks: rows }),
		partial,
	}
}

function parallelSubtasksMessage(partial: boolean): ClineMessage {
	return sayMessage(subtasks, partial)
}

function askMessage(text: string): ClineMessage {
	return { ts: 1000, type: "ask", ask: "tool", text }
}

const requestedTasks = [
	{ label: "Investigate parser", mode: "code", message: "Trace how the parser handles braces." },
	{ label: "Check tests", mode: "debug", message: "Find the missing assertion." },
]

function renderChatRow(message: ClineMessage, currentTaskItem?: Partial<HistoryItem>) {
	mockCurrentTaskItem = currentTaskItem

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

describe("ChatRow - parallelSubtasks say tool", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("renders the panel instead of falling into the transparent-row default (F10)", () => {
		const { container } = renderChatRow(parallelSubtasksMessage(true))

		expect(screen.getByText("Parallel investigations")).toBeInTheDocument()
		expect(screen.getByText("1 of 2 complete")).toBeInTheDocument()
		expect(screen.getByText("Investigate parser")).toBeInTheDocument()
		expect(screen.getByText("Check tests")).toBeInTheDocument()
		expect(container.querySelectorAll("[data-testid^='parallel-subtask-row-']")).toHaveLength(2)
	})

	it("renders the final count when partial is false", () => {
		renderChatRow(parallelSubtasksMessage(false))
		expect(screen.getByText("1 of 2 complete")).toBeInTheDocument()
	})

	it("routes the panel buttons through the existing message handlers", () => {
		renderChatRow(parallelSubtasksMessage(false))

		fireEvent.click(screen.getAllByRole("button", { name: "Report" })[0])
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/ws/.zoocode/subtask-reports/parent/investigate-parser-child-1.md",
		})

		fireEvent.click(screen.getAllByRole("button", { name: "JSON log" })[0])
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openDebugUiHistory", taskId: "child-1" })

		fireEvent.click(screen.getAllByRole("button", { name: "Go to task" })[1])
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-2" })
	})
})

describe("ChatRow - parallelSubtasks ask approval point (F-06)", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("renders the requested task list with label, mode and message preview", () => {
		renderChatRow(askMessage(JSON.stringify({ tool: "parallelSubtasks", tasks: requestedTasks })))

		expect(screen.getByText("Parallel investigations")).toBeInTheDocument()
		expect(screen.getByText("Investigate parser")).toBeInTheDocument()
		expect(screen.getByText("Check tests")).toBeInTheDocument()
		expect(screen.getByTestId("parallel-subtask-request-mode-0")).toHaveTextContent("code")
		expect(screen.getByTestId("parallel-subtask-request-mode-1")).toHaveTextContent("debug")
		expect(screen.getByTestId("parallel-subtask-request-message-0")).toHaveTextContent(
			"Trace how the parser handles braces.",
		)
		expect(screen.queryAllByTestId(/^parallel-subtask-row-/)).toHaveLength(0)
	})

	it.each([
		["a payload without tasks", JSON.stringify({ tool: "parallelSubtasks" })],
		["a payload with non-array tasks", JSON.stringify({ tool: "parallelSubtasks", tasks: "nope" })],
	])("keeps the approval row visible for %s", (_case, text) => {
		renderChatRow(askMessage(text))
		expect(screen.getByText("Parallel investigations")).toBeInTheDocument()
		expect(screen.queryAllByTestId(/^parallel-subtask-request-/)).toHaveLength(0)
	})
})

describe("ChatRow - parallelSubtasks synthetic rows (F-20)", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("hides the debug and navigation buttons for rows without a registered child", () => {
		renderChatRow(
			sayMessage(
				[
					{
						taskId: "child-1",
						label: "Investigate parser",
						mode: "code",
						status: "completed",
						summary: "done",
					},
					{
						taskId: "dropped-0",
						label: "Check tests",
						mode: "debug",
						status: "failed",
						error: "Dropped: the request exceeded the per-call limit (1 of 2 started)",
					},
					{ taskId: "synthetic-uuid", label: "Ghost", mode: "code", status: "failed", error: "Unknown mode" },
				],
				false,
			),
			{ childIds: ["child-1"] },
		)

		expect(screen.getByTestId("parallel-subtask-row-dropped-0")).toBeInTheDocument()
		expect(screen.getByTestId("parallel-subtask-row-synthetic-uuid")).toBeInTheDocument()
		expect(screen.getAllByRole("button", { name: "JSON log" })).toHaveLength(1)
		expect(screen.getAllByRole("button", { name: "Go to task" })).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Go to task" }))
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
	})
})
