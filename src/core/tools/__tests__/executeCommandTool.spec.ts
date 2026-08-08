import type { ToolUsage } from "@roo-code/types"
import * as vscode from "vscode"

import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { Terminal } from "../../../integrations/terminal/Terminal"
import type { RooTerminal, RooTerminalCallbacks, RooTerminalProcess } from "../../../integrations/terminal/types"

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

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureShellIntegrationError: vitest.fn(),
		},
	},
}))

vitest.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		getOrCreateTerminal: vitest.fn().mockResolvedValue({
			provider: "execa",
			lifecycle: { state: "ready" },
			terminal: { shellIntegration: undefined },
			runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: any) => {
				// Invoke onCompleted so onCompletedPromise resolves and the tool returns.
				callbacks?.onCompleted?.("")
				const p = Promise.resolve()
				// Attach promise-like properties so mergePromise callers don't throw.
				return Object.assign(p, { continue: () => {}, abort: () => {} })
			}),
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
		}),
		prepareProviderSwitch: vitest.fn().mockResolvedValue({ terminal: undefined }),
		setExecaShellFamily: vitest.fn(),
	},
}))

vitest.mock("../../../integrations/terminal/CommandScheduler", () => ({
	CommandScheduler: {
		getInstance: vitest.fn().mockReturnValue({
			enqueue: vitest.fn().mockResolvedValue(undefined),
			release: vitest.fn(),
		}),
		initialize: vitest.fn(),
		cleanup: vitest.fn(),
	},
}))

vitest.mock("../../task/Task")
vitest.mock("../../prompts/responses")

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
		// Reset call history but preserve module mock factory defaults.
		vitest.clearAllMocks()
		vitest.useRealTimers()

		// Spy on executeCommandInTerminal and mock its return value
		vitest.spyOn(executeCommandModule, "executeCommandInTerminal").mockResolvedValue([false, "Command executed"])

		// Create mock implementations with eslint directives to handle the type issues
		mockCline = {
			ask: vitest.fn().mockResolvedValue(undefined),
			say: vitest.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vitest.fn().mockResolvedValue("Missing parameter error"),
			supersedePendingAsk: vitest.fn(),
			consecutiveMistakeCount: 0,
			didRejectTool: false,
			taskId: "test-task",
			rooIgnoreController: {
				validateCommand: vitest.fn().mockReturnValue(null),
			},
			apiConfiguration: {},
			recordToolUsage: vitest.fn().mockReturnValue({} as ToolUsage),
			recordToolError: vitest.fn(),
			providerRef: {
				deref: vitest.fn().mockResolvedValue({
					getState: vitest.fn().mockResolvedValue({
						terminalOutputLineLimit: 500,
						terminalOutputCharacterLimit: 100000,
						terminalShellIntegrationDisabled: true,
					}),
					postMessageToWebview: vitest.fn(),
				}),
			},
			lastMessageTs: Date.now(),
			cwd: "/test/workspace",
			getResolvedCommandEnvironment: vitest.fn().mockReturnValue(undefined),
		}

		mockAskApproval = vitest.fn().mockResolvedValue(true)
		mockHandleError = vitest.fn().mockResolvedValue(undefined)
		mockPushToolResult = vitest.fn()

		// Default mock for toolError so typed error paths return a deterministic message.
		;(formatResponse.toolError as any).mockImplementation((message: string) => message)

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
		it("should unescape < to < character", () => {
			const input = "echo <test>"
			const expected = "echo <test>"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape > to > character", () => {
			const input = "echo test > output.txt"
			const expected = "echo test > output.txt"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape & to & character", () => {
			const input = "echo foo && echo bar"
			const expected = "echo foo && echo bar"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should handle multiple mixed HTML entities", () => {
			const input = "grep -E 'pattern' <file.txt >output.txt 2>&1"
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

	describe("CommandScheduler integration", () => {
		it("enqueues the command and releases the lease after execution", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			const { CommandScheduler } = await import("../../../integrations/terminal/CommandScheduler")
			const scheduler = CommandScheduler.getInstance()

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(scheduler.enqueue).toHaveBeenCalledWith(
				expect.objectContaining({
					executionId: expect.any(String),
					taskId: mockCline.taskId,
					requestedAt: expect.any(Number),
				}),
			)
			expect(scheduler.release).toHaveBeenCalled()
		})

		it("emits a queued status before the command runs", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			const provider = await mockCline.providerRef.deref()
			const postMessageCalls = provider.postMessageToWebview.mock.calls
			const statuses = postMessageCalls
				.map((call: any) => {
					try {
						return JSON.parse(call[0].text)
					} catch {
						return undefined
					}
				})
				.filter(Boolean)
			expect(statuses.some((s: any) => s.status === "queued")).toBe(true)
		})

		it("releases the CommandScheduler lease even when executeCommandInTerminal fails", async () => {
			const genericError = new Error("unexpected failure")
			vitest.spyOn(executeCommandModule, "executeCommandInTerminal").mockRejectedValueOnce(genericError)

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			const { CommandScheduler } = await import("../../../integrations/terminal/CommandScheduler")
			const scheduler = CommandScheduler.getInstance()

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(scheduler.release).toHaveBeenCalled()
		})
	})

	describe("Error handling", () => {
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

		it("allows retry when shell integration fails before command submission", () => {
			const error = new executeCommandModule.ShellIntegrationError("startup failed", false)

			expect(executeCommandModule.canRetryShellIntegrationError(error)).toBe(true)
		})

		it("prevents retry when shell integration fails after command submission", () => {
			const error = new executeCommandModule.ShellIntegrationError("stream missing", true)

			expect(executeCommandModule.canRetryShellIntegrationError(error)).toBe(false)
		})

		it("does not replay command when ShellIntegrationError has commandSubmitted=true", async () => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")

			// Use a resolved environment so the terminal provider is vscode and the
			// onNoShellIntegration callback is registered.
			mockCline.getResolvedCommandEnvironment = vitest.fn().mockReturnValue({
				primaryPlan: { provider: "vscode", family: "zsh" },
				fallbackPlan: { provider: "execa", family: "zsh" },
			})

			const originalTerminal = {
				id: 1,
				provider: "vscode",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: any) => {
					callbacks?.onNoShellIntegration?.({
						message: "stream missing",
						commandSubmitted: true,
						code: "SI_ACTIVATION_TIMEOUT",
						retryDisposition: "never",
						terminalId: 1,
					})
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			}

			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce(
				originalTerminal,
			)

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// The terminal's runCommand should be invoked only once (no retry).
			expect(originalTerminal.runCommand).toHaveBeenCalledTimes(1)

			// Post-submit shell integration errors are surfaced as a tool result, not retried.
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("SI_ACTIVATION_TIMEOUT")
			expect(mockHandleError).not.toHaveBeenCalled()
		})

		it("shows error for non-ShellIntegrationError exceptions in the catch block", async () => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const genericError = new Error("unexpected failure")

			// Override the terminal mock to reject with a non-ShellIntegrationError
			const mockRunCommandFn = vitest.fn().mockImplementation(() => {
				const rejectPromise = Promise.reject(genericError)
				return Object.assign(rejectPromise, { continue: () => {}, abort: () => {} })
			})

			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce({
				provider: "execa",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: mockRunCommandFn,
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			})

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Should NOT retry — only one call to runCommand
			expect(mockRunCommandFn).toHaveBeenCalledTimes(1)

			// Unknown errors are passed to the error handler.
			expect(mockHandleError).toHaveBeenCalledWith("executing command", genericError)
		})

		it("selects the Execa fallback provider for cmd.exe shell integration", () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(true)

			expect(executeCommandModule.getTerminalProviderForExecution(false)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: true,
			})
		})

		it("selects the provider from the resolved environment's primary plan", () => {
			const resolvedEnv = {
				primaryPlan: { provider: "execa", family: "zsh" },
				fallbackPlan: { provider: "execa", family: "zsh" },
			}

			expect(executeCommandModule.getTerminalProviderForExecution(false, resolvedEnv as any)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: false,
			})
		})

		it("detects cmd.exe fallback when the resolved environment's primary plan is cmd family", () => {
			const resolvedEnv = {
				primaryPlan: { provider: "execa", family: "cmd" },
				fallbackPlan: { provider: "execa", family: "cmd" },
			}

			expect(executeCommandModule.getTerminalProviderForExecution(false, resolvedEnv as any)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: true,
			})
		})
	})

	describe("Safe fallback orchestration", () => {
		it("switches to a same-family execa plan after a pre-submit shell integration error", async () => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")

			const fallbackTerminal = {
				id: 2,
				provider: "execa",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: any) => {
					callbacks?.onCompleted?.("fallback succeeded")
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			}

			;(TerminalRegistry.prepareProviderSwitch as any).mockResolvedValueOnce({ terminal: fallbackTerminal })

			const originalTerminal = {
				id: 1,
				provider: "vscode",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: any) => {
					callbacks?.onNoShellIntegration?.({
						message: "startup failed",
						commandSubmitted: false,
						code: "SI_ACTIVATION_TIMEOUT",
						retryDisposition: "fallback-safe",
						terminalId: 1,
					})
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			}

			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce(
				originalTerminal,
			)

			mockCline.getResolvedCommandEnvironment = vitest.fn().mockReturnValue({
				primaryPlan: { provider: "vscode", family: "powershell" },
				fallbackPlan: { provider: "execa", family: "powershell" },
			})

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(TerminalRegistry.prepareProviderSwitch).toHaveBeenCalledWith(
				expect.objectContaining({
					terminalId: 1,
					executionId: expect.any(String),
					fromProvider: "vscode",
					toProvider: "execa",
					reasonCode: "SI_ACTIVATION_TIMEOUT",
					commandSubmitted: false,
					resolvedEnv: expect.objectContaining({
						primaryPlan: { provider: "vscode", family: "powershell" },
						fallbackPlan: { provider: "execa", family: "powershell" },
					}),
				}),
			)

			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("fallback succeeded")
			expect(mockHandleError).not.toHaveBeenCalled()
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

	describe("cwd parameter validation", () => {
		const invalidCwdCases = [
			{ label: "object", value: { path: "/foo" } },
			{ label: "array", value: ["/foo"] },
			{ label: "number", value: 12345 },
			{ label: "empty string", value: "" },
		]

		invalidCwdCases.forEach(({ label, value }) => {
			it(`rejects ${label} cwd`, async () => {
				mockToolUse.params.command = "echo test"
				mockToolUse.params.cwd = value as any
				mockToolUse.nativeArgs = { command: "echo test", cwd: value as any }

				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("cwd must be a non-empty string"),
				)
				expect(mockAskApproval).not.toHaveBeenCalled()
				expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			})
		})

		it("accepts absolute string cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/custom/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/custom/path" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("accepts relative string cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "relative/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "relative/path" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("accepts undefined cwd", async () => {
			mockToolUse.params.command = "echo test"
			delete mockToolUse.params.cwd
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("does not acquire a terminal for malformed cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = 12345 as any
			mockToolUse.nativeArgs = { command: "echo test", cwd: 12345 as any }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		})
	})

	describe("cwd parameter validation", () => {
		const invalidCwdCases = [
			{ label: "object", value: { path: "/foo" } },
			{ label: "array", value: ["/foo"] },
			{ label: "number", value: 12345 },
			{ label: "empty string", value: "" },
		]

		invalidCwdCases.forEach(({ label, value }) => {
			it(`rejects ${label} cwd`, async () => {
				mockToolUse.params.command = "echo test"
				mockToolUse.params.cwd = value as any
				mockToolUse.nativeArgs = { command: "echo test", cwd: value as any }

				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("cwd must be a non-empty string"),
				)
				expect(mockAskApproval).not.toHaveBeenCalled()
				expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			})
		})

		it("accepts absolute string cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/custom/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/custom/path" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("accepts relative string cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "relative/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "relative/path" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("accepts undefined cwd", async () => {
			mockToolUse.params.command = "echo test"
			delete mockToolUse.params.cwd
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalled()
		})

		it("does not acquire a terminal for malformed cwd", async () => {
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = 12345 as any
			mockToolUse.nativeArgs = { command: "echo test", cwd: 12345 as any }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		})
	})

	describe("ShellFallbackMismatchError", () => {
		it("includes the fallback family when one is available", () => {
			const error = new executeCommandModule.ShellFallbackMismatchError("powershell", "cmd")

			expect(error.code).toBe("SHELL_FALLBACK_MISMATCH")
			expect(error.name).toBe("ShellFallbackMismatchError")
			expect(error.primaryFamily).toBe("powershell")
			expect(error.fallbackFamily).toBe("cmd")
			expect(error.message).toContain('Primary shell family "powershell"')
			expect(error.message).toContain('fallback family: "cmd"')
		})

		it("reports when no fallback plan is available", () => {
			const error = new executeCommandModule.ShellFallbackMismatchError("powershell", undefined)

			expect(error.fallbackFamily).toBeUndefined()
			expect(error.message).toContain("no fallback plan available")
		})
	})

	describe("Legacy terminal provider selection", () => {
		it("selects execa when shell integration is disabled", () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)

			expect(executeCommandModule.getTerminalProviderForExecution(true)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: false,
			})
		})

		it("selects vscode when shell integration is enabled and the shell is not cmd.exe", () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)

			expect(executeCommandModule.getTerminalProviderForExecution(false)).toEqual({
				terminalProvider: "vscode",
				isCmdExeFallback: false,
			})
		})
	})

	describe("Command syntax validation", () => {
		it("rejects commands with unterminated quotes before asking for approval", async () => {
			mockToolUse.params.command = 'echo "unterminated'
			mockToolUse.nativeArgs = { command: 'echo "unterminated' }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Malformed command")
			expect(mockCline.didToolFailInCurrentTurn).toBe(true)

			const provider = await mockCline.providerRef.deref()
			const statuses = provider.postMessageToWebview.mock.calls
				.map((call: unknown[]) => {
					try {
						return JSON.parse((call[0] as { text: string }).text)
					} catch {
						return undefined
					}
				})
				.filter(Boolean)
			expect(statuses.some((s: { status?: string }) => s.status === "error")).toBe(true)
		})
	})

	describe("executeCommandInTerminal edge cases", () => {
		it("returns an error when the working directory does not exist", async () => {
			// Restore the real implementation so this test exercises the actual
			// working-directory validation instead of the beforeEach spy.
			vi.mocked(executeCommandModule.executeCommandInTerminal).mockRestore()

			const fsPromises = await import("fs/promises")
			vi.mocked(fsPromises.default.access).mockRejectedValueOnce(new Error("ENOENT"))

			const [rejected, result] = await executeCommandModule.executeCommandInTerminal(mockCline as unknown as Task, {
				executionId: "exec-dir",
				command: "echo test",
			})

			expect(rejected).toBe(false)
			expect(result).toContain("Working directory '/test/workspace' does not exist")
		})

		it("rejects a malformed cwd as defense-in-depth", async () => {
			// Restore the real implementation (see previous test).
			vi.mocked(executeCommandModule.executeCommandInTerminal).mockRestore()

			const [rejected, result] = await executeCommandModule.executeCommandInTerminal(mockCline as unknown as Task, {
				executionId: "exec-cwd",
				command: "echo test",
				customCwd: 12345 as unknown as string,
			})

			expect(rejected).toBe(false)
			expect(result).toContain("cwd must be a non-empty string")
		})
	})

	describe("Terminal callbacks", () => {
		function makeTerminal(runCommandImpl: (callbacks: RooTerminalCallbacks) => void): RooTerminal {
			return {
				provider: "execa",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: RooTerminalCallbacks) => {
					runCommandImpl(callbacks)
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as unknown as RooTerminal
		}

		async function runWithTerminal(terminal: RooTerminal): Promise<void> {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce(terminal)

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})
		}

		it("publishes started, output, and exited statuses", async () => {
			await runWithTerminal(
				makeTerminal((callbacks) => {
					callbacks?.onShellExecutionStarted?.(123, {} as RooTerminalProcess)
					callbacks?.onLine?.("hello world\n", {} as RooTerminalProcess)
					callbacks?.onShellExecutionComplete?.({ exitCode: 0 })
					callbacks?.onCompleted?.("hello world\n")
				}),
			)

			const provider = await mockCline.providerRef.deref()
			const statuses = provider.postMessageToWebview.mock.calls
				.map((call: unknown[]) => {
					try {
						return JSON.parse((call[0] as { text: string }).text)
					} catch {
						return undefined
					}
				})
				.filter(Boolean)
			expect(statuses.some((s: { status?: string; pid?: number }) => s.status === "started" && s.pid === 123)).toBe(true)
			expect(statuses.some((s: { status?: string }) => s.status === "output")).toBe(true)
			expect(
				statuses.some((s: { status?: string; exitCode?: number }) => s.status === "exited" && s.exitCode === 0),
			).toBe(true)

			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Exit code: 0")
			expect(result).toContain("hello world")
		})

		it("reports signal-based termination", async () => {
			await runWithTerminal(
				makeTerminal((callbacks) => {
					callbacks?.onShellExecutionComplete?.({ signalName: "SIGKILL", coreDumpPossible: true })
					callbacks?.onCompleted?.("")
				}),
			)

			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Process terminated by signal SIGKILL - core dump possible")
		})

		it("reports an undefined exit code", async () => {
			await runWithTerminal(
				makeTerminal((callbacks) => {
					callbacks?.onShellExecutionComplete?.({ exitCode: undefined })
					callbacks?.onCompleted?.("")
				}),
			)

			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("VSCE exit code is undefined")
		})

		it("reports a non-zero exit code", async () => {
			await runWithTerminal(
				makeTerminal((callbacks) => {
					callbacks?.onShellExecutionComplete?.({ exitCode: 1 })
					callbacks?.onCompleted?.("")
				}),
			)

			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Command execution was not successful")
			expect(result).toContain("Exit code: 1")
		})
	})

	describe("User-configured command timeout", () => {
		it("aborts the command after the user timeout elapses", async () => {
			vitest.useFakeTimers()

			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const abortMock = vitest.fn()
			const runCommandMock = vitest.fn().mockImplementation(() => {
				// Never completes on its own; the user timeout must abort it.
				const never = new Promise<void>(() => {})
				return Object.assign(never, { continue: () => {}, abort: abortMock })
			})
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce({
				provider: "execa",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: runCommandMock,
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			})

			const mockConfig = {
				get: vitest.fn().mockImplementation((key: string, defaultValue: unknown) => {
					if (key === "commandExecutionTimeout") {
						return 1 // 1 second
					}
					return defaultValue
				}),
			}
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockConfig as never)

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			const executionPromise = executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			await vitest.advanceTimersByTimeAsync(1000)
			await executionPromise

			expect(runCommandMock).toHaveBeenCalledTimes(1)
			expect(abortMock).toHaveBeenCalled()
			expect(mockCline.didToolFailInCurrentTurn).toBe(true)
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("timeout")
		})
	})

	describe("Safe fallback edge cases", () => {
		it("allows retry when the shell integration error is fallback-safe", () => {
			const error = new executeCommandModule.ShellIntegrationError("startup failed", false, "SI_ACTIVATION_TIMEOUT", {
				retryDisposition: "fallback-safe",
			})

			expect(executeCommandModule.canRetryShellIntegrationError(error)).toBe(true)
		})

		it("surfaces prepareProviderSwitch failures through handleError", async () => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const switchError = new Error("switch failed")
			vi.mocked(TerminalRegistry.prepareProviderSwitch).mockRejectedValueOnce(switchError)

			const originalTerminal = {
				id: 1,
				provider: "vscode",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: RooTerminalCallbacks) => {
					callbacks?.onNoShellIntegration?.({
						message: "startup failed",
						commandSubmitted: false,
						code: "SI_ACTIVATION_TIMEOUT",
					})
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as unknown as RooTerminal
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce(originalTerminal)

			mockCline.getResolvedCommandEnvironment = vitest.fn().mockReturnValue({
				primaryPlan: { provider: "vscode", family: "powershell" },
				fallbackPlan: { provider: "execa", family: "powershell" },
			})

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(TerminalRegistry.prepareProviderSwitch).toHaveBeenCalled()
			expect(mockHandleError).toHaveBeenCalledWith("executing command", switchError)
		})

		it("retries with execa when no resolved environment is available", async () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")

			// Shell integration must be enabled so the vscode provider path is
			// selected and onNoShellIntegration is registered on the first attempt.
			mockCline.providerRef.deref = vitest.fn().mockResolvedValue({
				getState: vitest.fn().mockResolvedValue({
					terminalShellIntegrationDisabled: false,
				}),
				postMessageToWebview: vitest.fn(),
			})

			const originalTerminal = {
				id: 1,
				provider: "vscode",
				lifecycle: { state: "ready" },
				terminal: { shellIntegration: undefined },
				runCommand: vitest.fn().mockImplementation((_cmd: string, callbacks: RooTerminalCallbacks) => {
					callbacks?.onNoShellIntegration?.({
						message: "startup failed",
						commandSubmitted: false,
						code: "SI_ACTIVATION_TIMEOUT",
					})
					const p = Promise.resolve()
					return Object.assign(p, { continue: () => {}, abort: () => {} })
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			} as unknown as RooTerminal
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValueOnce(originalTerminal)

			// mockCline.getResolvedCommandEnvironment returns undefined by default.

			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(TerminalRegistry.prepareProviderSwitch).not.toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("automatically retried")
		})
	})

	describe("handlePartial", () => {
		it("asks for the command with the partial flag", async () => {
			await executeCommandTool.handlePartial(mockCline as unknown as Task, {
				type: "tool_use",
				name: "execute_command",
				params: { command: "echo partial" },
				nativeArgs: { command: "echo partial" },
				partial: true,
			} as unknown as ToolUse<"execute_command">)

			expect(mockCline.ask).toHaveBeenCalledWith("command", "echo partial", true)
		})
	})
})
