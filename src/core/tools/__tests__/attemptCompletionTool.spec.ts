import { RooCodeEventName, TodoItem } from "@roo-code/types"

import { AttemptCompletionToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import { AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import * as vscode from "vscode"

describe("attemptCompletionTool", () => {
	let mockTask: Partial<Task>
	let mockPushToolResult: ReturnType<typeof vi.fn<PushToolResult>>
	let mockAskApproval: ReturnType<typeof vi.fn<AskApproval>>
	let mockHandleError: ReturnType<typeof vi.fn<HandleError>>
	let mockToolDescription: ReturnType<typeof vi.fn<() => string>>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn<() => Promise<boolean>>>
	let mockGetConfiguration: ReturnType<typeof vi.fn<() => any>>

	beforeEach(() => {
		mockPushToolResult = vi.fn<PushToolResult>()
		mockAskApproval = vi.fn<AskApproval>()
		mockHandleError = vi.fn<HandleError>()
		mockToolDescription = vi.fn<() => string>()
		mockAskFinishSubTaskApproval = vi.fn<() => Promise<boolean>>()
		mockGetConfiguration = vi.fn<() => any>(() => ({
			get: vi.fn((key: string, defaultValue: any) => {
				if (key === "preventCompletionWithOpenTodos") {
					return defaultValue // Default to false unless overridden in test
				}
				return defaultValue
			}),
		}))

		// Setup vscode mock
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			messageCounts: { user: 0, assistant: 0 },
			taskId: "task_1",
			apiConfiguration: { apiProvider: "test" } as any,
			api: { getModel: vi.fn().mockReturnValue({ id: "test-model", info: {} }) } as any,
			flushTelemetryInstallment: vi.fn(),
			setPendingTaskAction: vi.fn(),
			persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
		}
	})

	describe("todo list validation", () => {
		it("should allow completion when there is no todo list", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = undefined

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not call pushToolResult with an error for empty todo list
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when todo list is empty", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = []

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should prevent completion when there are pending todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are in-progress todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithInProgress: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "in_progress" },
			]

			mockTask.todoList = todosWithInProgress

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are mixed incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const mixedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
				{ id: "3", content: "Third task", status: "in_progress" },
			]

			mockTask.todoList = mixedTodos

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is disabled even with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Ensure the setting is disabled (default behavior)
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return false // Setting is disabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not prevent completion when setting is disabled
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when setting is enabled with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should prevent completion when setting is enabled and there are incomplete todos
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is enabled but all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should allow completion when setting is enabled but all todos are completed
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		describe("tool failure guardrail", () => {
			it("should prevent completion when a previous tool failed in the current turn", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = true

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				const mockSay = vi.fn()
				mockTask.say = mockSay

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockSay).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
			})

			it("should allow completion when no tools failed", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = false

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
			})
		})

		describe("completion lifecycle", () => {
			it("delegates an active subtask completion when the active parent awaits that child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({ historyItem: { id, status: "active" } })
						}
						if (id === "parent-1") {
							return Promise.resolve({
								historyItem: { id, status: "active", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					clearPendingTaskAction: vi.fn().mockResolvedValue(true),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
				expect(mockProvider.setPendingTaskAction).toHaveBeenCalledWith("child-1", {
					kind: "finish_subtask",
					actionId: "call-attempt-completion",
					approvalText: JSON.stringify({ tool: "finishTask" }),
					parentTaskId: "parent-1",
					result: "9",
				})
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-attempt-completion",
				})
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith("")
			})

			it("falls through to standalone completion when parent delegation becomes stale after approval", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({ historyItem: { id, status: "active" } })
						}
						if (id === "parent-1") {
							return Promise.resolve({
								historyItem: { id, status: "delegated", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					clearPendingTaskAction: vi.fn().mockResolvedValue(true),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(false),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockTask.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "revise", images: [] })
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-stale-completion",
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-stale-completion",
				})
				expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledWith("child-1", "call-stale-completion")
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
				expect(mockPushToolResult).not.toHaveBeenCalledWith("")
				// Flush once per validated attempt_completion call, before delegation is
				// attempted, independent of whether delegation succeeds.
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
			})

			it("does not resume the parent when the parent is no longer awaiting this child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({ historyItem: { id, status: "active" } })
						}
						if (id === "parent-1") {
							return Promise.resolve({
								historyItem: { id, status: "active", awaitingChildId: undefined },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(undefined),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockProvider.log).toHaveBeenCalledWith(expect.stringContaining("Skipping delegation"))
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
			})

			it("delegates an interrupted subtask completion when the parent is still delegated and awaiting that child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({ historyItem: { id, status: "interrupted" } })
						}
						if (id === "parent-1") {
							return Promise.resolve({
								historyItem: { id, status: "delegated", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
				})
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith("")
			})

			it("does not resume the parent when the parent is active but awaiting a different child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({ historyItem: { id, status: "active" } })
						}
						if (id === "parent-1") {
							return Promise.resolve({
								historyItem: { id, status: "active", awaitingChildId: "different-child" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(undefined),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockProvider.log).toHaveBeenCalledWith(expect.stringContaining("Skipping delegation"))
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
			})

			it("emits TaskCompleted only when completion is accepted", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				expect(mockTask.emit).toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					"task_1",
					expect.anything(),
					expect.anything(),
				)
			})

			it("reports telemetry but does not emit the public TaskCompleted event when user provides follow-up feedback", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "Different question now: what is 3+3?",
					images: [],
				})

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				// Telemetry is reported on every model-initiated attempt_completion call,
				// regardless of whether the user accepts, declines, or gives feedback.
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				// The public RooCodeEventName.TaskCompleted API event still only fires once
				// the user actually accepts the result.
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			})

			it("durably persists queued completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
					"queued-1",
					"One more change",
					undefined,
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("One more change"))
			})

			it("does not continue when queued completion feedback persistence fails", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})
				mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockHandleError).toHaveBeenCalledWith(
					"inspecting site",
					expect.objectContaining({ message: expect.stringContaining("queued-1") }),
				)
				expect(mockPushToolResult).not.toHaveBeenCalled()
			})

			it("records image-only completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					images: ["data:image/png;base64,feedback"],
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", ["data:image/png;base64,feedback"])
				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			})

			it("does not clear pending metadata when stale delegation continues without an action id", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskWithId: vi.fn().mockImplementation((id: string) =>
						Promise.resolve({
							historyItem:
								id === "child-1"
									? { id, status: "active" }
									: { id, status: "delegated", awaitingChildId: "child-1" },
						}),
					),
					setPendingTaskAction: vi.fn(),
					clearPendingTaskAction: vi.fn(),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(false),
				}
				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "Done",
				})
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
			})
		})
	})
})

describe("attemptCompletionTool telemetry invariants", () => {
	function makeTask(overrides: Partial<Task> = {}): Partial<Task> {
		return {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			messageCounts: { user: 0, assistant: 0 },
			taskId: "task_1",
			flushTelemetryInstallment: vi.fn(),
			...overrides,
		}
	}

	it("does not emit a duplicate telemetry installment when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const mockProvider = {
			log: vi.fn(),
			getTaskWithId: vi.fn().mockImplementation((id: string) => {
				if (id === "child-1") return Promise.resolve({ historyItem: { id, status: "completed" } })
				throw new Error(`unexpected task id ${id}`)
			}),
			reopenParentFromDelegation: vi.fn(),
		}

		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			toolUsage: { read_file: { attempts: 5, failures: 0 } },
			messageCounts: { user: 3, assistant: 4 },
		})
		Object.assign(task, { providerRef: { deref: () => mockProvider } })

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).not.toHaveBeenCalled()
	})

	it("does not emit the public TaskCompleted event when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const mockProvider = {
			log: vi.fn(),
			getTaskWithId: vi.fn().mockImplementation((id: string) => {
				if (id === "child-1") return Promise.resolve({ historyItem: { id, status: "completed" } })
				throw new Error(`unexpected task id ${id}`)
			}),
			reopenParentFromDelegation: vi.fn(),
		}

		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})
		Object.assign(task, { providerRef: { deref: () => mockProvider } })

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})

	it("emits the public TaskCompleted API event only when completion is accepted, but reports telemetry either way", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(task.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			"task_1",
			expect.anything(),
			expect.anything(),
		)
	})

	it("still reports telemetry for a model-initiated completion even when the user provides follow-up feedback instead of accepting", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "one more thing", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})
})
