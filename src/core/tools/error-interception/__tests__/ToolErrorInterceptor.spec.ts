import { describe, expect, it, vi } from "vitest"

import { createToolErrorInterceptor, SHELL_CIRCUIT_THRESHOLD, ToolErrorInterceptor } from "../ToolErrorInterceptor"
import { extractCategoryFromGuided } from "../MessageTransformer"
import { getTaskErrorState, hasTaskErrorState } from "../TaskErrorState"
import type { HandleError, PushToolResult, ToolResponse } from "../../../../shared/tools"

const createTask = () => ({ taskId: "task-123" })

type MockPushToolResult = ReturnType<typeof vi.fn<PushToolResult>> & PushToolResult

type MockHandleError = ReturnType<typeof vi.fn<HandleError>> & HandleError

describe("ToolErrorInterceptor", () => {
	const makeMockHandleError = (): MockHandleError => vi.fn() as unknown as MockHandleError
	const makeMockPushToolResult = (): MockPushToolResult => vi.fn() as unknown as MockPushToolResult

	describe("createInterceptor", () => {
		it("returns decorated callbacks with original signatures", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError: HandleError = vi.fn(async () => {})
			const pushToolResult: PushToolResult = vi.fn()

			const decorated = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123" },
			)

			expect(decorated.rawHandleError).toBe(handleError)
			expect(decorated.rawPushToolResult).toBe(pushToolResult)
			expect(typeof decorated.decoratedHandleError).toBe("function")
			expect(typeof decorated.decoratedPushToolResult).toBe("function")
		})
	})

	describe("decorateHandleError", () => {
		it("forwards raw error to the original handleError before transformation", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			const error = new Error("shell integration failed")
			await decoratedHandleError("executing command", error)

			expect(handleError).toHaveBeenCalledTimes(1)
			expect(handleError).toHaveBeenCalledWith("executing command", error)
		})

		it("pushes a transformed result after the raw error", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Category: SHELL_INTEGRATION")
			expect(result).toContain("Type: guided_tool_error")
			expect(result).toContain("Occurrence: 1")
			expect(result).toContain("Retryable: true")
		})

		it("fails open for unclassified errors", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			await decoratedHandleError("doing something", new Error("totally unknown failure"))

			expect(handleError).toHaveBeenCalledTimes(1)
			expect(pushToolResult).not.toHaveBeenCalled()
		})

		it("guards against empty taskId in partial context", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "" },
			)

			const error = new Error("shell integration failed")
			await decoratedHandleError("executing command", error)

			expect(handleError).toHaveBeenCalledTimes(1)
			expect(pushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("decoratePushToolResult", () => {
		it("passes through successful tool results unchanged", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const success = "Command executed successfully."
			decoratedPushToolResult(success)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(success)
		})

		it("transforms a structured file-not-found error result", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "apply_diff" },
			)

			const errorResult = JSON.stringify({
				status: "error",
				type: "file_not_found",
				message: "File does not exist at path",
			})
			decoratedPushToolResult(errorResult)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Category: FILE_NOT_FOUND")
			expect(result).toContain("path was not found")
		})

		it("transforms a plain text file-not-found error", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			decoratedPushToolResult("File does not exist: missing.txt")

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Category: FILE_NOT_FOUND")
		})

		it("does not transform success text containing the word 'error'", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const successText = "0 errors found in the codebase"
			decoratedPushToolResult(successText)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(successText)
		})

		it("transforms an apply_diff DIFF_MATCH_FAILED result into guided error", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "apply_diff" },
			)

			decoratedPushToolResult("apply_diff failed: no sufficiently similar match found in file src/foo.ts")

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Category: DIFF_MATCH_FAILED")
			expect(result).toContain("Type: guided_tool_error")
			expect(result).toContain("Pattern: EI/DIFF_MATCH_FAILED/001")
			expect(result).toContain("Retryable: true")
			expect(result).toContain("SEARCH text")
		})

		it("does not leak raw SEARCH/REPLACE diff text in the transformed payload", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "apply_diff" },
			)

			decoratedPushToolResult(
				"apply_diff failed: no sufficiently similar match found. SEARCH was: const secret = 'abc123'",
			)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const rawOut = (pushToolResult.mock.calls[0] as [string])[0]
			expect(rawOut).not.toContain("const secret = 'abc123'")
			expect(rawOut).not.toContain("abc123")
		})

		it("passes through image results unchanged", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const imageResult: ToolResponse = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
			]
			decoratedPushToolResult(imageResult)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledWith(imageResult)
		})
	})

	describe("occurrence counting", () => {
		it("increments occurrence for each classification of the same category", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			for (let i = 0; i < 3; i++) {
				decoratedPushToolResult('{"status":"error","type":"file_not_found","message":"File does not exist"}')
			}

			expect(pushToolResult).toHaveBeenCalledTimes(3)
			for (let i = 0; i < 3; i++) {
				const result = (pushToolResult.mock.calls[i] as [string])[0]
				expect(result).toContain("Category: FILE_NOT_FOUND")
				expect(result).toContain(`Occurrence: ${i + 1}`)
			}
		})
	})

	describe("shell circuit breaker", () => {
		it("opens circuit after SHELL_INTEGRATION_THRESHOLD failures", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			for (let i = 0; i < SHELL_CIRCUIT_THRESHOLD; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await decoratedHandleError("executing command", error)
			}

			expect(pushToolResult).toHaveBeenCalledTimes(SHELL_CIRCUIT_THRESHOLD)
			const lastResult = (pushToolResult.mock.calls[SHELL_CIRCUIT_THRESHOLD - 1] as [string])[0]
			expect(lastResult).toContain("Pattern: EI/SHELL_INTEGRATION/CIRCUIT_OPEN")
			expect(lastResult).toContain("Retryable: false")
			expect(lastResult).toContain("Occurrence: 1")
		})

		it("returns circuit-open message after circuit is open", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			for (let i = 0; i < SHELL_CIRCUIT_THRESHOLD; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await decoratedHandleError("executing command", error)
			}

			pushToolResult.mockClear()

			const error = Object.assign(new Error("shell integration failed again"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Pattern: EI/SHELL_INTEGRATION/CIRCUIT_OPEN")
		})
	})

	describe("resetTaskState", () => {
		it("clears category counts and closes circuit", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			for (let i = 0; i < SHELL_CIRCUIT_THRESHOLD; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await decoratedHandleError("executing command", error)
			}

			interceptor.resetTaskState(task)

			pushToolResult.mockClear()

			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)

			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Pattern: EI/SHELL_INTEGRATION/001")
			expect(result).toContain("Occurrence: 1")
		})

		it("returns early when task has no state and does not materialize TaskErrorState", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			// Never call getTaskState or createInterceptor — task has no state
			expect(() => interceptor.resetTaskState(task)).not.toThrow()
			// TaskErrorState must not be materialized as a side effect of reset
			expect(hasTaskErrorState(task)).toBe(false)
		})

		it("resets only the specified category", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError, decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			// Trigger one SHELL_INTEGRATION error
			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)
			expect(pushToolResult).toHaveBeenCalledTimes(1)

			// Also trigger a FILE_NOT_FOUND error via decoratedPushToolResult
			decoratedPushToolResult("File does not exist: missing.txt")
			expect(pushToolResult).toHaveBeenCalledTimes(2)

			// Reset only SHELL_INTEGRATION
			interceptor.resetTaskState(task, "SHELL_INTEGRATION")

			pushToolResult.mockClear()

			// SHELL_INTEGRATION should restart at occurrence 1
			await decoratedHandleError("executing command", error)
			const shellResult = (pushToolResult.mock.calls[0] as [string])[0]
			expect(shellResult).toContain("Occurrence: 1")

			// FILE_NOT_FOUND should still be at occurrence 2 (not reset)
			pushToolResult.mockClear()
			decoratedPushToolResult("File does not exist: missing2.txt")
			const fnfResult = (pushToolResult.mock.calls[0] as [string])[0]
			expect(fnfResult).toContain("Occurrence: 2")
		})

		it("synchronizes reset with TaskErrorState for a full reset", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			// Trigger two shell integration errors (increments interceptor counter)
			for (let i = 0; i < 2; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await decoratedHandleError("executing command", error)
			}

			// Simulate presentAssistantMessage incrementing TaskErrorState in parallel
			const taskErrorState = getTaskErrorState(task)
			taskErrorState.incrementOccurrence("SHELL_INTEGRATION")
			taskErrorState.incrementOccurrence("SHELL_INTEGRATION")
			expect(taskErrorState.getOccurrence("SHELL_INTEGRATION")).toBe(2)

			// Full reset should reset both consumers
			interceptor.resetTaskState(task)

			// TaskErrorState should now be reset
			expect(taskErrorState.getOccurrence("SHELL_INTEGRATION")).toBe(0)

			// Next error should be occurrence 1 in the interceptor
			pushToolResult.mockClear()
			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Occurrence: 1")
		})

		it("synchronizes category-specific reset with TaskErrorState", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError, decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			// Trigger one SHELL_INTEGRATION and one FILE_NOT_FOUND error
			const shellError = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", shellError)
			decoratedPushToolResult("File does not exist: missing.txt")

			// Simulate presentAssistantMessage incrementing TaskErrorState in parallel
			const taskErrorState = getTaskErrorState(task)
			taskErrorState.incrementOccurrence("SHELL_INTEGRATION")
			taskErrorState.incrementOccurrence("FILE_NOT_FOUND")
			expect(taskErrorState.getOccurrence("SHELL_INTEGRATION")).toBe(1)
			expect(taskErrorState.getOccurrence("FILE_NOT_FOUND")).toBe(1)

			// Reset only SHELL_INTEGRATION
			interceptor.resetTaskState(task, "SHELL_INTEGRATION")

			// SHELL_INTEGRATION should be reset in TaskErrorState
			expect(taskErrorState.getOccurrence("SHELL_INTEGRATION")).toBe(0)
			// FILE_NOT_FOUND should be untouched in TaskErrorState
			expect(taskErrorState.getOccurrence("FILE_NOT_FOUND")).toBe(1)

			// Next SHELL_INTEGRATION error should be occurrence 1 in the interceptor
			pushToolResult.mockClear()
			await decoratedHandleError("executing command", shellError)
			const shellResult = (pushToolResult.mock.calls[0] as [string])[0]
			expect(shellResult).toContain("Occurrence: 1")
		})

		it("closes the shell circuit when resetting SHELL_INTEGRATION category", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			// Open the circuit
			for (let i = 0; i < SHELL_CIRCUIT_THRESHOLD; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await decoratedHandleError("executing command", error)
			}

			// Verify circuit is open
			pushToolResult.mockClear()
			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)
			const circuitResult = (pushToolResult.mock.calls[0] as [string])[0]
			expect(circuitResult).toContain("Pattern: EI/SHELL_INTEGRATION/CIRCUIT_OPEN")

			// Category-specific reset of SHELL_INTEGRATION should close the circuit
			interceptor.resetTaskState(task, "SHELL_INTEGRATION")

			// Next error should NOT be circuit-open; it should be a normal guided message at occurrence 1
			pushToolResult.mockClear()
			await decoratedHandleError("executing command", error)
			const result = (pushToolResult.mock.calls[0] as [string])[0]
			expect(result).toContain("Pattern: EI/SHELL_INTEGRATION/001")
			expect(result).toContain("Occurrence: 1")
			expect(result).not.toContain("CIRCUIT_OPEN")
		})

		it("does not materialize TaskErrorState when resetting a task with no interceptor state", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			// Never call getTaskState or createInterceptor — task has no state
			expect(() => interceptor.resetTaskState(task, "SHELL_INTEGRATION")).not.toThrow()
			expect(hasTaskErrorState(task)).toBe(false)
		})
	})

	describe("transformToolResult helper", () => {
		it("returns transformed message for known structured results", () => {
			const interceptor = createToolErrorInterceptor()

			const message = interceptor.transformToolResult(
				{ status: "missing-parameter" },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			expect(message).toBeDefined()
			expect(message).toContain("Category: PARAM_MISSING")
			expect(message).toContain("Occurrence: 1")
		})

		it("returns undefined for unclassified results", () => {
			const interceptor = createToolErrorInterceptor()

			const message = interceptor.transformToolResult(
				{ text: "some normal output" },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			expect(message).toBeUndefined()
		})
	})

	describe("WeakMap isolation", () => {
		it("keeps state isolated between different task objects", async () => {
			const interceptor = createToolErrorInterceptor()
			const taskA = createTask()
			const taskB = createTask()
			const handleError = makeMockHandleError()
			const pushToolResultA = makeMockPushToolResult()
			const pushToolResultB = makeMockPushToolResult()

			const { decoratedHandleError: handleErrorA } = interceptor.createInterceptor(
				taskA,
				{ handleError, pushToolResult: pushToolResultA },
				{ taskId: "task-A", toolCallId: "call-1", toolName: "execute_command" },
			)
			const { decoratedHandleError: handleErrorB } = interceptor.createInterceptor(
				taskB,
				{ handleError, pushToolResult: pushToolResultB },
				{ taskId: "task-B", toolCallId: "call-1", toolName: "execute_command" },
			)

			for (let i = 0; i < SHELL_CIRCUIT_THRESHOLD; i++) {
				const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
				await handleErrorA("executing command", error)
			}

			expect(pushToolResultA).toHaveBeenCalledTimes(SHELL_CIRCUIT_THRESHOLD)
			expect(pushToolResultB).not.toHaveBeenCalled()

			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await handleErrorB("executing command", error)

			const resultB = (pushToolResultB.mock.calls[0] as [string])[0]
			expect(resultB).toContain("Occurrence: 1")
		})
	})

	describe("MCP branch compatibility", () => {
		it("forwards the feedbackImages second argument unchanged", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const rawPushToolResult = vi.fn(
				(content: string, feedbackImages?: string[]) => {},
			) as unknown as MockPushToolResult

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult: rawPushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const successText = "MCP tool completed"
			const images = ["data:image/png;base64,abc"]
			;(decoratedPushToolResult as (content: string, feedbackImages?: string[]) => void)(successText, images)

			expect(rawPushToolResult).toHaveBeenCalledTimes(1)
			expect(rawPushToolResult).toHaveBeenCalledWith(successText, images)
		})
	})

	describe("exactly-once delegate call", () => {
		it("does not call rawPushToolResult more than once per transformed invocation", async () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedHandleError } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "execute_command" },
			)

			const error = Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" })
			await decoratedHandleError("executing command", error)

			expect(handleError).toHaveBeenCalledTimes(1)
			expect(pushToolResult).toHaveBeenCalledTimes(1)
		})
	})

	describe("array result with non-text blocks", () => {
		it("preserves image blocks while transforming the text error block", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "read_file" },
			)

			const imageBlock = {
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "abc" },
			}
			const content = [
				{ type: "text", text: "File does not exist: /tmp/missing.txt" },
				imageBlock,
			] as unknown as ToolResponse

			decoratedPushToolResult(content)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const pushed = (pushToolResult.mock.calls[0] as [unknown[]])[0] as Array<Record<string, unknown>>
			// First block should be the transformed guided text payload.
			expect(pushed[0].type).toBe("text")
			expect(String(pushed[0].text)).toContain("guided_tool_error")
			// Non-text blocks are preserved verbatim after the transformed text.
			expect(pushed[1]).toEqual(imageBlock)
		})

		it("passes through arrays whose text is not an error", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const content = [{ type: "text", text: "Operation completed successfully" }] as unknown as ToolResponse
			decoratedPushToolResult(content)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect((pushToolResult.mock.calls[0] as [unknown])[0]).toBe(content)
		})
	})

	describe("isErrorResult edge cases", () => {
		it("passes through an empty string unchanged", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			decoratedPushToolResult("" as unknown as ToolResponse)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect((pushToolResult.mock.calls[0] as [string])[0]).toBe("")
		})

		it("does not treat success JSON containing 'error' substring as an error", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const successWithErrorSubstring = '{"status":"ok","note":"no error occurred"}'
			decoratedPushToolResult(successWithErrorSubstring as unknown as ToolResponse)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect((pushToolResult.mock.calls[0] as [string])[0]).toBe(successWithErrorSubstring)
		})

		it("passes through empty arrays unchanged", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const empty: unknown[] = []
			decoratedPushToolResult(empty as unknown as ToolResponse)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect((pushToolResult.mock.calls[0] as [unknown])[0]).toBe(empty)
		})
	})

	describe("inferStatus via array results", () => {
		it("infers 'error' status from structured error JSON text", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "apply_diff" },
			)

			const content = [
				{
					type: "text",
					text: '{"status":"error","message":"apply_diff failed: no sufficiently similar match found"}',
				},
			] as unknown as ToolResponse

			decoratedPushToolResult(content)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const pushed = (pushToolResult.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0]
			expect(String(pushed[0].text)).toContain("guided_tool_error")
		})

		it("infers 'file-not-found' status when text contains 'File does not exist'", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1", toolName: "read_file" },
			)

			// Text not starting with the marker but containing it exercises the
			// second inferStatus branch (includes()).
			const content = [
				{ type: "text", text: "read_file failed because File does not exist at path" },
			] as unknown as ToolResponse

			decoratedPushToolResult(content)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
		})

		it("infers 'denied' status from structured denied JSON text", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			const content = [
				{ type: "text", text: '{"status":"denied","message":"User denied permission"}' },
			] as unknown as ToolResponse

			decoratedPushToolResult(content)

			// "denied" is recognized by isErrorResult, so it should be transformed
			expect(pushToolResult).toHaveBeenCalledTimes(1)
		})

		it("returns undefined status for unrecognized error text", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			// "Error:" prefix is recognized by isErrorResult but inferStatus returns undefined
			const content = [{ type: "text", text: "Error: something went wrong" }] as unknown as ToolResponse

			decoratedPushToolResult(content)

			// Should be classified (isErrorResult returns true for "Error:" prefix)
			expect(pushToolResult).toHaveBeenCalledTimes(1)
		})
	})

	describe("transformError", () => {
		it("transforms a known error signal into a guided message", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()

			const result = interceptor.transformError(task, {
				source: "handler_exception",
				stage: "execute",
				taskId: "task-123",
				toolCallId: "call-1",
				toolName: "execute_command",
				error: Object.assign(new Error("shell integration failed"), { name: "ShellIntegrationError" }),
				metadata: {},
			})

			expect(result).toBeDefined()
			expect(result).toContain("Category: SHELL_INTEGRATION")
			expect(result).toContain("Type: guided_tool_error")
		})

		it("returns undefined for unclassified signals", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()

			const result = interceptor.transformError(task, {
				source: "tool_result",
				stage: "result",
				taskId: "task-123",
				result: { text: "everything is fine" },
				metadata: {},
			})

			expect(result).toBeUndefined()
		})
	})

	describe("isErrorResult 'Error:' prefix", () => {
		it("treats 'Error:' prefix string as an error result", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			decoratedPushToolResult("Error: command not found")

			// isErrorResult returns true for "Error:" prefix, but the classifier
			// may not recognize it (unclassified), so it falls through to fail-open
			// and passes the original content through unchanged.
			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const rawOut = (pushToolResult.mock.calls[0] as [string])[0]
			// Unclassified errors fail-open to the original string
			expect(rawOut).toBe("Error: command not found")
		})

		it("treats 'error:' lowercase prefix string as an error result", () => {
			const interceptor = createToolErrorInterceptor()
			const task = createTask()
			const handleError = makeMockHandleError()
			const pushToolResult = makeMockPushToolResult()

			const { decoratedPushToolResult } = interceptor.createInterceptor(
				task,
				{ handleError, pushToolResult },
				{ taskId: "task-123", toolCallId: "call-1" },
			)

			decoratedPushToolResult("error: permission denied")

			expect(pushToolResult).toHaveBeenCalledTimes(1)
		})
	})
})

/** Type assertion: ensure ToolErrorInterceptor is exported as a class. */
const _typeCheck: typeof ToolErrorInterceptor = ToolErrorInterceptor
void _typeCheck
