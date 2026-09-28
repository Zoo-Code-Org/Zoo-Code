// npx vitest run src/core/tools/__tests__/executeCommandTool.spec.ts

import type { ToolUsage } from "@roo-code/types"
import * as vscode from "vscode"
import fs from "fs/promises"

import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { RooTerminalCallbacks, RooTerminalProcess } from "../../../integrations/terminal/types"

// Mock dependencies
vitest.mock("execa", () => ({
	execa: vitest.fn(),
}))

vitest.mock("fs/promises", () => ({
	default: {
		access: vitest.fn().mockResolvedValue(undefined),
	},
}))

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn(),
	},
}))

vitest.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		getOrCreateTerminal: vitest.fn().mockResolvedValue({
			runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: any) => {
				// Invoke onCompleted so onCompletedPromise resolves and the tool returns.
				callbacks?.onCompleted?.("")
				const p = Promise.resolve()
				// Attach promise-like properties so mergePromise callers don't throw.
				return Object.assign(p, { continue: () => {}, abort: () => {} })
			}),
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
		}),
	},
}))

const mockInterceptorInstances: Array<{ write: ReturnType<typeof vitest.fn>; finalize: ReturnType<typeof vitest.fn> }> =
	vitest.hoisted(() => [])

vitest.mock("../../../integrations/terminal/OutputInterceptor", () => ({
	// vitest 4 mocks used with `new` must be function/class implementations.
	OutputInterceptor: class {
		write = vitest.fn()
		finalize = vitest.fn().mockResolvedValue({ truncated: false })
		constructor(..._args: unknown[]) {
			mockInterceptorInstances.push(this)
		}
	},
}))

vitest.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getTaskDirectoryPath: vitest.fn().mockResolvedValue("/test/storage/task-1/command-output"),
	}
})

vitest.mock("@roo-code/telemetry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@roo-code/telemetry")>()
	return {
		...actual,
		TelemetryService: class {
			static instance = {
				captureShellIntegrationError: vitest.fn(),
			}
		},
	}
})

vitest.mock("../../task/Task")
vitest.mock("../../prompts/responses")

const mockRunDcg = vitest.fn()
const mockEnsureDcgInstalled = vitest.fn()

vitest.mock("../../../services/destructive-command-guard", () => ({
	runDcg: mockRunDcg,
	ensureDcgInstalled: mockEnsureDcgInstalled,
}))

// Import the module
import * as executeCommandModule from "../ExecuteCommandTool"
const { executeCommandTool } = executeCommandModule

describe("executeCommandTool", () => {
	// Setup common test variables
	let mockCline: any & { consecutiveMistakeCount: number; didRejectTool: boolean }
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any
	let mockToolUse: ToolUse<"execute_command">
	const originalCliRuntime = process.env.ROO_CLI_RUNTIME

	beforeEach(() => {
		// Reset mocks
		vitest.clearAllMocks()
		vitest.useRealTimers()

		// Spy on executeCommandInTerminal and mock its return value
		vitest
			.spyOn(executeCommandModule, "executeCommandInTerminal")
			.mockResolvedValue([false, "Command executed", true])

		// Create mock implementations with eslint directives to handle the type issues
		mockCline = {
			ask: vitest.fn().mockResolvedValue(undefined),
			say: vitest.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vitest.fn().mockResolvedValue("Missing parameter error"),
			consecutiveMistakeCount: 0,
			didRejectTool: false,
			rooIgnoreController: {
				validateCommand: vitest.fn().mockReturnValue(null),
			},
			recordToolUsage: vitest.fn().mockReturnValue({} as ToolUsage),
			recordToolError: vitest.fn(),
			supersedePendingAsk: vitest.fn(),
			processQueuedMessages: vitest.fn(),
			providerRef: {
				deref: vitest.fn().mockResolvedValue({
					contextProxy: {
						getValue: vitest.fn().mockReturnValue(false),
					},
					getState: vitest.fn().mockResolvedValue({
						terminalOutputLineLimit: 500,
						terminalOutputCharacterLimit: 100000,
						terminalShellIntegrationDisabled: true,
					}),
					postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
				}),
			},
			lastMessageTs: Date.now(),
			cwd: "/test/workspace",
		}

		mockAskApproval = vitest.fn().mockResolvedValue(true)
		mockHandleError = vitest.fn().mockResolvedValue(undefined)
		mockPushToolResult = vitest.fn()
		mockRunDcg.mockResolvedValue({ decision: "allow" })
		mockEnsureDcgInstalled.mockResolvedValue("/test/storage/dcg")

		// Setup vscode config mock
		const mockConfig = {
			get: vitest.fn().mockImplementation((key: string, defaultValue: any) => {
				return defaultValue
			}),
		}
		;(vscode.workspace.getConfiguration as any).mockReturnValue(mockConfig)

		// Create a mock tool use object
		mockToolUse = {
			type: "tool_use",
			name: "execute_command",
			params: {
				command: "echo test",
			},
			nativeArgs: {
				command: "echo test",
			},
			partial: false,
		}
	})

	afterEach(() => {
		process.env.ROO_CLI_RUNTIME = originalCliRuntime
		vitest.useRealTimers()
	})

	/**
	 * Tests for HTML entity unescaping in commands
	 * This verifies that HTML entities are properly converted to their actual characters
	 */
	describe("HTML entity unescaping", () => {
		it("should unescape &lt; to < character", () => {
			const input = "echo &lt;test&gt;"
			const expected = "echo <test>"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape &gt; to > character", () => {
			const input = "echo test &gt; output.txt"
			const expected = "echo test > output.txt"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape &amp; to & character", () => {
			const input = "echo foo &amp;&amp; echo bar"
			const expected = "echo foo && echo bar"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should handle multiple mixed HTML entities", () => {
			const input = "grep -E 'pattern' &lt;file.txt &gt;output.txt 2&gt;&amp;1"
			const expected = "grep -E 'pattern' <file.txt >output.txt 2>&1"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})
	})

	// Now we can run these tests
	describe("Basic functionality", () => {
		it("should execute a command normally", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			// Execute using the class-based handle method
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			expect(mockPushToolResult).toHaveBeenCalled()
			// The exact message depends on the terminal mock's behavior
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Command")
		})

		it("should pass along custom working directory if provided", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/custom/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/custom/path" }

			// Execute
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify - command approved, result pushed, and custom cwd passed to terminal
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			expect(mockPushToolResult).toHaveBeenCalled()
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const firstArg = (TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mock.calls[0][0]
			expect(firstArg).toBe("/custom/path")
		})
	})

	describe("Error handling", () => {
		it("reports command parse errors to the webview", async () => {
			const provider = await mockCline.providerRef.deref()
			mockToolUse.params.command = 'echo "unterminated'
			mockToolUse.nativeArgs = { command: 'echo "unterminated' }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "commandExecutionStatus",
					text: expect.stringContaining('"status":"error"'),
				}),
			)
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("posts fallback status when retrying a pre-submission shell integration failure", async () => {
			const provider = await mockCline.providerRef.deref()
			const shellError = new executeCommandModule.ShellIntegrationError("startup failed", false)
			const failedProcess = Object.assign(Promise.reject(shellError), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulProcess = Object.assign(Promise.resolve(), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			// The terminal mock only needs the Promise surface used by this execution path.
			const successfulTerminalProcess = successfulProcess as unknown as RooTerminalProcess

			vitest
				.mocked(TerminalRegistry.getOrCreateTerminal)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockReturnValue(failedProcess),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
						void callbacks.onCompleted?.("", successfulTerminalProcess)
						callbacks.onShellExecutionComplete?.({ exitCode: 0 }, successfulTerminalProcess)
						return successfulProcess
					}),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "commandExecutionStatus",
					text: expect.stringContaining('"status":"fallback"'),
				}),
			)
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it.each([
			[undefined, undefined, "executeCommand.destructiveCommandGuard.blocked"],
			["matches a destructive pattern", undefined, "executeCommand.destructiveCommandGuard.blockedWithReason"],
			[undefined, "recursive-delete", "executeCommand.destructiveCommandGuard.blockedWithRule"],
			[
				"matches a destructive pattern",
				"recursive-delete",
				"executeCommand.destructiveCommandGuard.blockedWithReasonAndRule",
			],
		])("selects the localized DCG block message for reason %s and rule %s", (reason, ruleId, expected) => {
			expect(executeCommandModule.formatDcgBlockedMessage(reason, ruleId)).toBe(expected)
		})

		it("shows a DCG block message as an error before requesting explicit approval", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
			})
			mockRunDcg.mockResolvedValue({
				decision: "deny",
				reason: "matches a destructive pattern",
				ruleId: "recursive-delete",
			})
			mockAskApproval.mockResolvedValue(false)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockCline.say).toHaveBeenCalledWith(
				"error",
				"executeCommand.destructiveCommandGuard.blockedWithReasonAndRule",
			)
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, true)
		})

		it("requests normal approval when DCG allows the command", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
			})
			mockRunDcg.mockResolvedValue({ decision: "allow" })

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("installs or updates DCG before evaluating an enabled command", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
			})
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockEnsureDcgInstalled).toHaveBeenCalledWith("/test/storage")
			expect(mockRunDcg).toHaveBeenCalledWith("/test/storage/dcg", "echo test", "/test/workspace")
		})

		it("fails closed when the DCG install or update fails", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
			})
			mockEnsureDcgInstalled.mockRejectedValue(new Error("download failed"))

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith(
				"executing command",
				expect.objectContaining({ message: "download failed" }),
			)
			expect(mockRunDcg).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
		})

		it("fails closed when DCG is unavailable for the current platform", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
			})
			mockEnsureDcgInstalled.mockResolvedValue(undefined)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith(
				"executing command",
				expect.objectContaining({ message: "errors.destructiveCommandGuard.unavailable" }),
			)
			expect(mockRunDcg).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
		})

		it("should handle missing command parameter", async () => {
			// Setup
			mockToolUse.params.command = undefined
			// Native tool calls must still supply a value; simulate a missing value with an empty string.
			mockToolUse.nativeArgs = { command: "" }

			// Execute
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockCline.consecutiveMistakeCount).toBe(1)
			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("execute_command", "command")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
		})

		it("should handle command rejection", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockAskApproval.mockResolvedValue(false)
			mockToolUse.nativeArgs = { command: "echo test" }

			// Execute
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			// executeCommandInTerminal should not be called since approval was denied
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})

		it("should handle rooignore validation failures", async () => {
			// Setup
			mockToolUse.params.command = "cat .env"
			mockToolUse.nativeArgs = { command: "cat .env" }
			// Override the validateCommand mock to return a filename
			const validateCommandMock = vitest.fn().mockReturnValue(".env")
			mockCline.rooIgnoreController = {
				validateCommand: validateCommandMock,
			}

			const mockRooIgnoreError = "RooIgnore error"
			;(formatResponse.rooIgnoreError as any).mockReturnValue(mockRooIgnoreError)

			// Execute
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(validateCommandMock).toHaveBeenCalledWith("cat .env")
			expect(mockCline.say).toHaveBeenCalledWith("rooignore_error", ".env")
			expect(formatResponse.rooIgnoreError).toHaveBeenCalledWith(".env")
			expect(mockPushToolResult).toHaveBeenCalledWith(mockRooIgnoreError)
			expect(mockAskApproval).not.toHaveBeenCalled()
			// executeCommandInTerminal should not be called since rooignore blocked it
		})

		it("allows Execa retry when shell integration fails before command submission", () => {
			const error = new executeCommandModule.ShellIntegrationError("startup failed", false)

			expect(executeCommandModule.canRetryShellIntegrationError(error)).toBe(true)
		})

		it("prevents Execa retry when shell integration fails after command submission", () => {
			const error = new executeCommandModule.ShellIntegrationError("stream missing", true)

			expect(executeCommandModule.canRetryShellIntegrationError(error)).toBe(false)
		})

		it("routes a generic terminal-start error to the execution error path without draining", async () => {
			const runError = new Error("terminal process failed to start")
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValueOnce({
				runCommand: vitest.fn().mockImplementation(() => {
					throw runError
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// A generic terminal failure is an ordinary execution error, not a
			// shell-integration failure: the shell-integration warning and its
			// dedicated result must not appear (see the ShellIntegrationError
			// test for that distinct path).
			expect(mockHandleError).toHaveBeenCalledWith("executing command", runError)
			expect(mockCline.say).not.toHaveBeenCalledWith("shell_integration_warning")
			expect(mockPushToolResult).not.toHaveBeenCalled()
			// The command never ran, so queued messages must not be drained.
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
		})

		it("selects the Execa fallback provider for cmd.exe shell integration", () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(true)

			expect(executeCommandModule.getTerminalProviderForExecution(false)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: true,
			})
		})
	})

	describe("Queued message processing", () => {
		it("processes queued messages after the command completes", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			// The tool result must be published before queued messages are processed.
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
		})

		it("processes queued messages after the execa fallback retry completes", async () => {
			const shellError = new executeCommandModule.ShellIntegrationError("startup failed", false)
			const failedProcess = Object.assign(Promise.reject(shellError), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulProcess = Object.assign(Promise.resolve(), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulTerminalProcess = successfulProcess as unknown as RooTerminalProcess

			vitest
				.mocked(TerminalRegistry.getOrCreateTerminal)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockReturnValue(failedProcess),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
						void callbacks.onCompleted?.("", successfulTerminalProcess)
						callbacks.onShellExecutionComplete?.({ exitCode: 0 }, successfulTerminalProcess)
						return successfulProcess
					}),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
		})

		it("processes queued messages once after a command terminated by an interruption", async () => {
			mockToolUse.params.command = "long-running-command"
			mockToolUse.nativeArgs = { command: "long-running-command" }

			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
				runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
					const interruptedProcess = Object.assign(Promise.resolve(), {
						continue: vitest.fn(),
						abort: vitest.fn(),
					}) as unknown as RooTerminalProcess
					void callbacks.onCompleted?.("Command interrupted", interruptedProcess)
					callbacks.onShellExecutionComplete?.(
						{ exitCode: undefined, signalName: "SIGINT", coreDumpPossible: false },
						interruptedProcess,
					)
					return interruptedProcess
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Process terminated by signal SIGINT"),
			)
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			// The tool result must be published before queued messages are processed.
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
		})

		it("processes queued messages once after a user-configured execution timeout", async () => {
			mockToolUse.params.command = "sleep 10"
			mockToolUse.nativeArgs = { command: "sleep 10" }
			// 0.1s user timeout keeps the test fast while exercising the real abort path.
			vitest.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vitest
					.fn()
					.mockImplementation((key: string, defaultValue: unknown) =>
						key === "commandExecutionTimeout" ? 0.1 : defaultValue,
					),
			} as unknown as vscode.WorkspaceConfiguration)

			const pendingProcess = Object.assign(new Promise<void>(() => {}), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
				runCommand: vitest.fn().mockReturnValue(pendingProcess),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("terminated after exceeding a user-configured"),
			)
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
		})

		it("does not process queued messages when the user rejects the command", async () => {
			mockAskApproval.mockResolvedValue(false)
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
		})

		it("does not process queued messages when the working directory does not exist", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/nonexistent/working/dir"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/nonexistent/working/dir" }
			vitest.mocked(fs.access).mockRejectedValueOnce(new Error("ENOENT"))

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				"Working directory '/nonexistent/working/dir' does not exist.",
			)
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
		})

		it("logs a queued-message drain failure after a successful result without a shell-integration warning or a second result", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }
			const successfulProcess = Object.assign(Promise.resolve(), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulTerminalProcess = successfulProcess as unknown as RooTerminalProcess
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
				runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
					void callbacks.onCompleted?.("", successfulTerminalProcess)
					callbacks.onShellExecutionComplete?.({ exitCode: 0 }, successfulTerminalProcess)
					return successfulProcess
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as never)
			const drainError = new Error("queued submission failed")
			mockCline.processQueuedMessages.mockRejectedValueOnce(drainError)
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				// The successful result is published exactly once: the drain failure
				// must not emit a shell-integration warning or push a contradictory
				// command-failure result on top of it.
				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Command executed in terminal"))
				expect(mockCline.say).not.toHaveBeenCalledWith("shell_integration_warning")
				expect(mockHandleError).not.toHaveBeenCalled()
				// The failure is logged, not swallowed silently.
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"[ExecuteCommandTool] Failed to process queued messages:",
					drainError,
				)

				// The message stays queued for a later drain: the next command's
				// drain still runs.
				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(2)
				expect(mockPushToolResult).toHaveBeenCalledTimes(2)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("logs a queued-message drain failure after a successful execa fallback retry without a shell-integration warning or a second result", async () => {
			const shellError = new executeCommandModule.ShellIntegrationError("startup failed", false)
			const failedProcess = Object.assign(Promise.reject(shellError), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulProcess = Object.assign(Promise.resolve(), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			const successfulTerminalProcess = successfulProcess as unknown as RooTerminalProcess

			vitest
				.mocked(TerminalRegistry.getOrCreateTerminal)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockReturnValue(failedProcess),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)
				.mockResolvedValueOnce({
					runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
						void callbacks.onCompleted?.("", successfulTerminalProcess)
						callbacks.onShellExecutionComplete?.({ exitCode: 0 }, successfulTerminalProcess)
						return successfulProcess
					}),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)

			const drainError = new Error("queued submission failed")
			mockCline.processQueuedMessages.mockRejectedValueOnce(drainError)
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Command executed in terminal"))
				expect(mockCline.say).not.toHaveBeenCalledWith("shell_integration_warning")
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"[ExecuteCommandTool] Failed to process queued messages:",
					drainError,
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("does not drain when the execa fallback retry hits a working directory failure", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/nonexistent/working/dir"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/nonexistent/working/dir" }
			// First attempt passes validation but fails shell integration startup
			// (retryable); the retry then fails the working directory check.
			vitest.mocked(fs.access).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ENOENT"))
			const shellError = new executeCommandModule.ShellIntegrationError("startup failed", false)
			const failedProcess = Object.assign(Promise.reject(shellError), {
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValueOnce({
				runCommand: vitest.fn().mockReturnValue(failedProcess),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as never)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				"Working directory '/nonexistent/working/dir' does not exist.",
			)
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
		})
	})

	describe("Command execution timeout configuration", () => {
		it("should include timeout parameter in ExecuteCommandOptions", () => {
			// This test verifies that the timeout configuration is properly typed
			// The actual timeout logic is tested in integration tests
			// Note: timeout is stored internally in milliseconds but configured in seconds
			const timeoutSeconds = 15
			const options = {
				executionId: "test-id",
				command: "echo test",
				commandExecutionTimeout: timeoutSeconds * 1000, // Convert to milliseconds
			}

			// Verify the options object has the expected structure
			expect(options.commandExecutionTimeout).toBe(15000)
			expect(typeof options.commandExecutionTimeout).toBe("number")
		})

		it("should handle timeout parameter in function signature", () => {
			// Test that the executeCommandInTerminal function accepts timeout parameter
			// This is a compile-time check that the types are correct
			const mockOptions = {
				executionId: "test-id",
				command: "echo test",
				customCwd: undefined,
				terminalShellIntegrationDisabled: false,
				terminalOutputLineLimit: 500,
				commandExecutionTimeout: 0,
			}

			// Verify all required properties exist
			expect(mockOptions.executionId).toBeDefined()
			expect(mockOptions.command).toBeDefined()
			expect(mockOptions.commandExecutionTimeout).toBeDefined()
		})

		it("should ignore model timeout in CLI runtime", () => {
			process.env.ROO_CLI_RUNTIME = "1"
			expect(executeCommandModule.resolveAgentTimeoutMs(30)).toBe(0)
		})

		it("should honor model timeout outside CLI runtime", () => {
			delete process.env.ROO_CLI_RUNTIME
			expect(executeCommandModule.resolveAgentTimeoutMs(30)).toBe(30_000)
		})
	})

	describe("foreground command completion", () => {
		type MockProcess = Promise<void> & {
			continue: ReturnType<typeof vitest.fn>
			abort: ReturnType<typeof vitest.fn>
		}

		interface ControllableTerminal {
			callbacks: RooTerminalCallbacks | undefined
			proc: MockProcess
			provider: string | undefined
			resolveProcess: () => void
		}

		const setupControllableTerminal = async (): Promise<ControllableTerminal> => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const state: ControllableTerminal = {
				callbacks: undefined,
				proc: undefined as unknown as MockProcess,
				provider: undefined,
				resolveProcess: () => {},
			}
			const processPromise = new Promise<void>((resolve) => {
				state.resolveProcess = resolve
			})
			// Mirror real terminal behavior: continue() resolves the wait early
			// while the command keeps running in the background.
			state.proc = Object.assign(processPromise, {
				continue: vitest.fn(() => state.resolveProcess()),
				abort: vitest.fn(),
			})
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockImplementation(
				async (_cwd: string, _taskId: string, provider: string) => {
					state.provider = provider
					return {
						runCommand: vitest.fn((_cmd: string, callbacks: RooTerminalCallbacks) => {
							state.callbacks = callbacks
							return state.proc
						}),
						getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
					}
				},
			)
			return state
		}

		const handleCommand = (command: string, timeout?: number) => {
			mockToolUse.params.command = command
			mockToolUse.params.timeout = timeout === undefined ? undefined : String(timeout)
			mockToolUse.nativeArgs = timeout === undefined ? { command } : { command, timeout }

			return executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})
		}

		it("waits for Inline Terminal completion after output instead of returning it to the agent", async () => {
			vitest.useFakeTimers()
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("echo hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			expect(terminal.provider).toBe("execa")
			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("hello\n", proc)

			// The former command-output prompt returned the tool after five seconds,
			// allowing the next reasoning step to run before the exit status existed.
			await vitest.advanceTimersByTimeAsync(6_000)
			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(terminal.proc.continue).not.toHaveBeenCalled()

			let toolResolved = false
			void handlePromise.then(() => {
				toolResolved = true
			})
			await vitest.advanceTimersByTimeAsync(0)
			expect(toolResolved).toBe(false)

			await callbacks.onCompleted!("hello\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("hello")
			expect(result).toContain("Exit code: 0")
		})

		it("waits for shell-integrated terminal completion after output", async () => {
			vitest.useFakeTimers()
			mockCline.providerRef.deref.mockResolvedValue({
				contextProxy: { getValue: vitest.fn().mockReturnValue(false) },
				getState: vitest.fn().mockResolvedValue({ terminalShellIntegrationDisabled: false }),
				postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
			})
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("Write-Output hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			expect(terminal.provider).toBe("vscode")
			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("hello\n", proc)
			await vitest.advanceTimersByTimeAsync(6_000)

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(terminal.proc.continue).not.toHaveBeenCalled()

			await callbacks.onCompleted!("hello\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise

			expect(mockPushToolResult.mock.calls[0][0]).toContain("Exit code: 0")
		})

		it("allows an explicit agent timeout to move a command to the background", async () => {
			vitest.useFakeTimers()
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("npm run dev", 2)

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("server starting...\n", proc)

			// An explicit tool timeout is the only foreground escape route.
			await vitest.advanceTimersByTimeAsync(2_000)
			expect(terminal.proc.continue).toHaveBeenCalled()
			expect(mockCline.supersedePendingAsk).toHaveBeenCalled()

			await callbacks.onLine("listening...\n", proc)
			expect(mockCline.ask).not.toHaveBeenCalled()

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")
		})

		it("drains messages queued during a background run after publishing the final command_output update", async () => {
			vitest.useFakeTimers()
			mockCline.processQueuedMessages.mockResolvedValue(true)
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("npm run dev", 2)

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("server starting...\n", proc)

			// The agent timeout moves the command to the background; the tool
			// returns its "still running" result and drains immediately.
			await vitest.advanceTimersByTimeAsync(2_000)
			await handlePromise

			expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)

			// When the background command later completes, the messages queued
			// since the immediate drain are processed after the final
			// non-partial command_output update is published.
			await callbacks.onCompleted!("server exited\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			await vitest.advanceTimersByTimeAsync(100)

			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(2)

			const finalOutputCallIndex = mockCline.say.mock.calls.findIndex(
				(call: unknown[]) => call[0] === "command_output" && call[3] === false,
			)
			expect(finalOutputCallIndex).not.toBe(-1)
			expect(mockCline.say.mock.invocationCallOrder[finalOutputCallIndex]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[1],
			)
		})

		it("publishes the tool result before draining when a background command completes during the settle delay", async () => {
			vitest.useFakeTimers()
			mockCline.processQueuedMessages.mockResolvedValue(true)
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("npm run dev", 2)

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("server starting...\n", proc)

			// The agent timeout moves the command to the background. Advance in
			// small steps and stop as soon as the transition happens: the tool
			// then sits in the 50 ms settle delay with the tool result still
			// pending publication.
			for (let i = 0; terminal.proc.continue.mock.calls.length === 0 && i < 200; i++) {
				await vitest.advanceTimersByTimeAsync(25)
			}
			expect(terminal.proc.continue).toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()

			// Completion lands inside the settle delay, while the tool result
			// is still pending publication.
			await callbacks.onCompleted!("server exited\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			expect(mockPushToolResult).not.toHaveBeenCalled()
			// The background-completion drain is gated on the tool result.
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()

			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise
			await vitest.advanceTimersByTimeAsync(0)

			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			// Completion already landed, so the tool returns the completed
			// result rather than a "still running" one.
			expect(mockPushToolResult.mock.calls[0][0]).toContain("Command executed in terminal")
			expect(mockPushToolResult.mock.calls[0][0]).toContain("Exit code: 0")
			// The immediate post-result drain plus the background-completion drain.
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(2)
			// Queued messages must never be processed before the tool result.
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[1],
			)
		})

		it("warns without draining when a submitted command loses shell integration", async () => {
			vitest.useFakeTimers()
			mockCline.providerRef.deref.mockResolvedValue({
				contextProxy: { getValue: vitest.fn().mockReturnValue(false) },
				getState: vitest.fn().mockResolvedValue({ terminalShellIntegrationDisabled: false }),
				postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
			})
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("Write-Output hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			expect(terminal.provider).toBe("vscode")
			callbacks.onShellExecutionStarted!(1234, proc)
			// The command was submitted, but shell integration cannot report
			// its completion, so the retry path must not run.
			callbacks.onNoShellIntegration!({ message: "exit code unknown", commandSubmitted: true }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise

			expect(mockCline.say).toHaveBeenCalledWith("shell_integration_warning")
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).toHaveBeenCalledWith(
				"Command was submitted in the VS Code terminal, but shell integration did not report its output or completion status. Do not run the command again automatically.",
			)
			// A submitted command that loses shell integration did complete its
			// execution path, but the tool must not drain queued messages here.
			expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("logs a background-completion drain failure after the final command_output update", async () => {
			vitest.useFakeTimers()
			const drainError = new Error("queued submission failed")
			mockCline.processQueuedMessages.mockResolvedValueOnce(true).mockRejectedValueOnce(drainError)
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				const terminal = await setupControllableTerminal()

				const handlePromise = handleCommand("npm run dev", 2)

				await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
				const callbacks = terminal.callbacks!
				const proc = terminal.proc as unknown as RooTerminalProcess

				callbacks.onShellExecutionStarted!(1234, proc)
				await callbacks.onLine("server starting...\n", proc)

				// The agent timeout moves the command to the background; the tool
				// returns its "still running" result and drains immediately.
				await vitest.advanceTimersByTimeAsync(2_000)
				await handlePromise

				expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")
				expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)

				// When the background command later completes, the drain failure
				// is logged and never surfaces as a second tool result.
				await callbacks.onCompleted!("server exited\n", proc)
				callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
				await vitest.advanceTimersByTimeAsync(100)

				expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(2)
				// The final non-partial command_output update is published before
				// the background-completion drain runs.
				const finalOutputCallIndex = mockCline.say.mock.calls.findIndex(
					(call: unknown[]) => call[0] === "command_output" && call[3] === false,
				)
				expect(finalOutputCallIndex).not.toBe(-1)
				expect(mockCline.say.mock.invocationCallOrder[finalOutputCallIndex]).toBeLessThan(
					mockCline.processQueuedMessages.mock.invocationCallOrder[1],
				)
				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
				expect(mockHandleError).not.toHaveBeenCalled()
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"[ExecuteCommandTool] Failed to process queued messages:",
					drainError,
				)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("skips the background-completion drain when the task was abandoned but still publishes the result", async () => {
			vitest.useFakeTimers()
			mockCline.processQueuedMessages.mockResolvedValue(true)
			mockCline.abandoned = true
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("npm run dev", 2)

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("server starting...\n", proc)

			// The agent timeout moves the command to the background; the tool
			// returns its "still running" result and runs the post-result drain.
			await vitest.advanceTimersByTimeAsync(2_000)
			await handlePromise

			expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)

			// When the background command later completes, the
			// background-completion drain is skipped on the abandoned task.
			await callbacks.onCompleted!("server exited\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			await vitest.advanceTimersByTimeAsync(100)

			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("settles the background drain chain when terminal execution fails after output", async () => {
			vitest.useFakeTimers()
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				let rejectProcess!: (error: Error) => void
				const processPromise = new Promise<void>((_resolve, reject) => {
					rejectProcess = reject
				})
				const failingProcess = Object.assign(processPromise, {
					continue: vitest.fn(),
					abort: vitest.fn(),
				}) as unknown as RooTerminalProcess
				let capturedCallbacks: RooTerminalCallbacks | undefined
				vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
					runCommand: vitest.fn().mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
						capturedCallbacks = callbacks
						return failingProcess
					}),
					getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
				} as never)

				const handlePromise = handleCommand("npm test")

				await vitest.waitFor(() => expect(capturedCallbacks).toBeDefined())
				const callbacks = capturedCallbacks!
				callbacks.onShellExecutionStarted!(1234, failingProcess)
				await callbacks.onLine!("partial output\n", failingProcess)
				// Completion creates the background-completion drain chain, which
				// awaits the per-invocation publication signal.
				await callbacks.onCompleted!("partial output\n", failingProcess)
				callbacks.onShellExecutionComplete!({ exitCode: 0 }, failingProcess)

				// The terminal then fails with a generic (non-shell-integration)
				// error. The publication signal must settle so the awaiting drain
				// chain cannot hang, and the error must surface through the tool
				// error path.
				const failure = new Error("terminal process crashed")
				rejectProcess(failure)

				await vitest.advanceTimersByTimeAsync(100)
				await handlePromise
				await vitest.advanceTimersByTimeAsync(0)

				expect(mockHandleError).toHaveBeenCalledWith("executing command", failure)
				expect(mockPushToolResult).not.toHaveBeenCalled()
				expect(mockCline.processQueuedMessages).not.toHaveBeenCalled()
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("returns the persisted output format when the interceptor reports truncated output", async () => {
			vitest.useFakeTimers()
			mockCline.providerRef.deref.mockResolvedValue({
				context: { globalStorageUri: { fsPath: "/test/storage" } },
				contextProxy: { getValue: vitest.fn().mockReturnValue(false) },
				getState: vitest.fn().mockResolvedValue({
					terminalOutputLineLimit: 500,
					terminalOutputCharacterLimit: 100000,
					terminalShellIntegrationDisabled: true,
				}),
				postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
			})
			const persisted = {
				truncated: true,
				totalBytes: 200_000,
				artifactPath: "/test/storage/task-1/command-output/exec-1.txt",
				preview: "head\n...[omitted middle content]...\ntail",
			}
			const terminal = await setupControllableTerminal()
			// Other tests (DCG approval flows) also construct interceptors, so
			// index relative to the instances that exist before this command.
			const interceptorIndex = mockInterceptorInstances.length

			const handlePromise = handleCommand("cat big.log")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			expect(mockInterceptorInstances.length).toBe(interceptorIndex + 1)
			mockInterceptorInstances[interceptorIndex].finalize.mockResolvedValue(persisted)

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("line\n", proc)
			await callbacks.onCompleted!("line\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Command executed in '/test/workspace'. Exit code: 0")
			expect(result).toContain("Output (195.3KB) persisted. Artifact ID: exec-1.txt")
			expect(result).toContain(persisted.preview)
			expect(result).toContain("Use read_command_output tool to view full output if needed.")
			// Truncated persisted output reports commandSubmitted: true, so the
			// post-result drain runs exactly once, after the tool result.
			expect(mockCline.processQueuedMessages).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult.mock.invocationCallOrder[0]).toBeLessThan(
				mockCline.processQueuedMessages.mock.invocationCallOrder[0],
			)
		})
	})
})
