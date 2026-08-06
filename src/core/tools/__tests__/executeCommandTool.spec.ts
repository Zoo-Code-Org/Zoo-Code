import type { ToolUsage } from "@roo-code/types"
import * as vscode from "vscode"

import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { Terminal } from "../../../integrations/terminal/Terminal"

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
					contextProxy: {
						getValue: vitest.fn().mockReturnValue(false),
					},
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
		mockRunDcg.mockResolvedValue({ decision: "allow" })
		mockEnsureDcgInstalled.mockResolvedValue("/test/storage/dcg")

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
})
