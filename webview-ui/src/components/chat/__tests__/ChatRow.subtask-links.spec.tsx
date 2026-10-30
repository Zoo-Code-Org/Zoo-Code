import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"
import type { HistoryItem, ClineMessage } from "@roo-code/types"

const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"chat:subtasks.wantsToCreate": "Roo wants to create a new subtask",
				"chat:subtasks.resultContent": "Task result",
				"chat:subtasks.goToSubtask": "Go to subtask",
			}
			return map[key] ?? key
		},
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

let mockCurrentTaskItem: Partial<HistoryItem> | undefined = undefined
let mockClineMessages: ClineMessage[] = []

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: mockClineMessages,
		currentTaskItem: mockCurrentTaskItem,
	}),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

function renderChatRow(message: ClineMessage, currentTaskItem?: Partial<HistoryItem>, clineMessages?: ClineMessage[]) {
	mockCurrentTaskItem = currentTaskItem
	mockClineMessages = clineMessages ?? [message]

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

function newTask(ts: number, childTaskId?: string): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify({ tool: "newTask", mode: "code", content: "Implement feature X" }),
		childTaskId,
	}
}

function subtaskResult(ts: number, childTaskId?: string): ClineMessage {
	return { ts, type: "say", say: "subtask_result", text: "Subtask completed", childTaskId }
}

function expectSubtaskLink(childTaskId: string) {
	fireEvent.click(screen.getByRole("button", { name: "Go to subtask" }))
	expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: childTaskId })
}

function interveningMessages(): ClineMessage[] {
	return [
		{ ts: 1100, type: "say", say: "text", text: "Working" },
		{ ts: 1200, type: "ask", ask: "tool", text: "not valid JSON" },
		{ ts: 1300, type: "ask", ask: "tool", text: JSON.stringify({ tool: "switchMode", mode: "code" }) },
	]
}

describe("ChatRow - subtask links", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	describe("newTask tool", () => {
		it.each([0, 1])("maps legacy ask %s to its positional child", (taskIndex) => {
			const messages = [newTask(1000), ...interveningMessages(), newTask(2000)]
			const asks = [messages[0], messages.at(-1)!]
			const childIds = ["first-child", "second-child"]
			renderChatRow(asks[taskIndex], { childIds }, messages)
			expectSubtaskLink(childIds[taskIndex])
		})

		it.each([undefined, { childIds: ["wrong-child"] }])(
			"uses the stamped child regardless of task metadata: %j",
			(currentTaskItem) => {
				renderChatRow(newTask(1000, "stamped-child"), currentTaskItem)
				expectSubtaskLink("stamped-child")
			},
		)

		it.each(["rejected", "approved", "pending"] as const)(
			"resolves the %s ask when a rejected ask precedes a stamped approval",
			(row) => {
				const rejected = { ...newTask(1000), isAnswered: true }
				const approved = newTask(2000, "approved-child")
				const pending = newTask(3000)
				const messages = [rejected, approved, pending]
				renderChatRow(
					{ rejected, approved, pending }[row],
					{ childIds: ["approved-child"], completedByChildId: "approved-child" },
					messages,
				)
				if (row === "approved") {
					expectSubtaskLink("approved-child")
				} else {
					expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
				}
			},
		)

		it.each([undefined, { childIds: [], completedByChildId: "previous-child" }])(
			"does not link a pending ask without a child: %j",
			(currentTaskItem) => {
				renderChatRow(newTask(1000), currentTaskItem)
				expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
			},
		)

		it("does not link a pending legacy ask to an earlier child", () => {
			const pending = newTask(3000)
			renderChatRow(pending, { childIds: ["first-child"], completedByChildId: "first-child" }, [
				newTask(1000),
				subtaskResult(2000),
				pending,
			])
			expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
		})

		it.each([undefined, "child-task"])("hides the adjacent duplicate button with stamp %s", (childTaskId) => {
			const message = newTask(1000, childTaskId)
			renderChatRow(message, { childIds: ["child-task"] }, [message, subtaskResult(2000, childTaskId)])
			expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
		})

		it("keeps the ask link when the result is not adjacent", () => {
			const message = newTask(1000)
			renderChatRow(message, { childIds: ["child-task"] }, [
				message,
				...interveningMessages(),
				subtaskResult(2000),
			])
			expectSubtaskLink("child-task")
		})
	})

	describe("subtask_result say message", () => {
		it.each([0, 1])("links legacy result %s to the most recent preceding ask", (resultIndex) => {
			const results = [subtaskResult(2000), subtaskResult(4000)]
			const childIds = ["first-child", "second-child"]
			renderChatRow(results[resultIndex], { childIds, completedByChildId: "second-child" }, [
				newTask(1000),
				...interveningMessages(),
				results[0],
				newTask(3000),
				{ ts: 3500, type: "say", say: "text", text: "Still working" },
				results[1],
			])
			expectSubtaskLink(childIds[resultIndex])
		})

		it.each([0, 1])("uses the stamp for out-of-order result %s", (resultIndex) => {
			const childIds = ["first-child", "second-child"]
			const results = [subtaskResult(3000, "second-child"), subtaskResult(4000, "first-child")]
			renderChatRow(results[resultIndex], { childIds, completedByChildId: "second-child" }, [
				newTask(1000, "first-child"),
				newTask(2000, "second-child"),
				...results,
			])
			expectSubtaskLink(results[resultIndex].childTaskId!)
		})

		it("uses the preceding ask stamp across intervening messages and rejected asks", () => {
			const result = subtaskResult(3000)
			renderChatRow(result, { childIds: ["approved-child"], completedByChildId: "wrong-child" }, [
				{ ...newTask(500), isAnswered: true },
				newTask(1000, "approved-child"),
				...interveningMessages(),
				result,
			])
			expectSubtaskLink("approved-child")
		})

		it("uses the latest completed child instead of a shifted legacy position", () => {
			const result = subtaskResult(3000)
			renderChatRow(
				result,
				{ childIds: ["completed-child", "running-child"], completedByChildId: "completed-child" },
				[newTask(1000), newTask(2000), result, newTask(4000)],
			)
			expectSubtaskLink("completed-child")
		})

		it("uses a result stamp without task metadata or an originating ask", () => {
			renderChatRow(subtaskResult(1000, "stamped-child"))
			expectSubtaskLink("stamped-child")
		})

		it.each([false, true])("preserves completedByChildId fallback with preceding ask: %s", (includeAsk) => {
			const result = subtaskResult(2000)
			renderChatRow(result, { completedByChildId: "completed-child" }, [
				...(includeAsk ? [newTask(1000)] : []),
				result,
			])
			expectSubtaskLink("completed-child")
		})

		it("does not link an earlier result to the latest completed child when its position is taken", () => {
			const earlierResult = subtaskResult(2000)
			renderChatRow(earlierResult, { childIds: ["second-child"], completedByChildId: "second-child" }, [
				newTask(1000),
				earlierResult,
				newTask(3000, "second-child"),
				subtaskResult(4000),
			])
			expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
		})

		it.each([
			{ ts: 1500, type: "say", say: "text", text: newTask(0).text },
			{ ts: 1500, type: "ask", ask: "followup", text: newTask(0).text },
		] as ClineMessage[])("does not count non-tool-ask newTask JSON as a delegation: %j", (lookalike) => {
			const result = subtaskResult(2000)
			renderChatRow(result, { childIds: ["first-child", "second-child"] }, [newTask(1000), lookalike, result])
			expectSubtaskLink("first-child")
		})

		it("does not link a result missing from the message list", () => {
			renderChatRow(subtaskResult(2000), { completedByChildId: "completed-child" }, [newTask(1000)])
			expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
		})

		it.each([false, true])("does not link an unresolved result with preceding ask: %s", (includeAsk) => {
			const result = subtaskResult(2000)
			renderChatRow(result, undefined, [...(includeAsk ? [newTask(1000)] : []), result])
			expect(screen.queryByRole("button", { name: "Go to subtask" })).not.toBeInTheDocument()
		})
	})
})
