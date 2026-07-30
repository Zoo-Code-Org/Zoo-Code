// npx vitest run src/core/tools/__tests__/executeCommandTool.spec.ts

import type { ToolUsage } from "@roo-code/types"
import * as vscode from "vscode"

import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { Terminal } from "../../../integrations/terminal/Terminal"
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
		vitest.spyOn(executeCommandModule, "executeCommandInTerminal").mockResolvedValue([false, "Command executed"])

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
		})

		it("installs or updates DCG before evaluating an enabled command", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
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

		it("selects the Execa fallback provider for cmd.exe shell integration", () => {
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(true)

			expect(executeCommandModule.getTerminalProviderForExecution(false)).toEqual({
				terminalProvider: "execa",
				isCmdExeFallback: true,
			})
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

	describe("command_output ask policy", () => {
		type MockProcess = Promise<void> & {
			continue: ReturnType<typeof vitest.fn>
			abort: ReturnType<typeof vitest.fn>
		}

		interface ControllableTerminal {
			callbacks: RooTerminalCallbacks | undefined
			proc: MockProcess
			resolveProcess: () => void
		}

		const setupControllableTerminal = async (): Promise<ControllableTerminal> => {
			const { TerminalRegistry } = await import("../../../integrations/terminal/TerminalRegistry")
			const state: ControllableTerminal = {
				callbacks: undefined,
				proc: undefined as unknown as MockProcess,
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
			;(TerminalRegistry.getOrCreateTerminal as ReturnType<typeof vitest.fn>).mockResolvedValue({
				runCommand: vitest.fn((_cmd: string, callbacks: RooTerminalCallbacks) => {
					state.callbacks = callbacks
					return state.proc
				}),
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
			})
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

		it("does not ask about command output when a short command emits output and exits normally", async () => {
			vitest.useFakeTimers()
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("echo hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("hello\n", proc)
			await callbacks.onCompleted!("hello\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()

			// Advance past the ask delay to prove the scheduled ask was cancelled
			// on completion, not merely deferred beyond the test's runtime.
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS + 1_000)

			await handlePromise

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("hello")
			expect(result).toContain("Exit code: 0")
		})

		it("asks about command output when the command is still running after the ask delay", async () => {
			vitest.useFakeTimers()
			mockCline.ask.mockResolvedValue({ response: "messageResponse", text: "keep going", images: undefined })
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 60")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("working...\n", proc)

			// First output alone must not trigger the ask.
			expect(mockCline.ask).not.toHaveBeenCalled()

			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS)

			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")
			expect(terminal.proc.continue).toHaveBeenCalled()

			// Further output after the ask must not schedule another ask.
			await callbacks.onLine("still working...\n", proc)
			expect(mockCline.ask).toHaveBeenCalledTimes(1)

			// Let the command finish so the tool can resolve.
			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("anchors the ask delay to execution start so shell integration startup does not consume it", async () => {
			vitest.useFakeTimers()
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("echo hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			// Simulate a cold terminal spending most of the grace period waiting
			// for shell integration before the command actually starts.
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS - 2_000)
			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("hello\n", proc)

			// Past the pre-runCommand anchor deadline but well within the window
			// measured from execution start: still no ask.
			await vitest.advanceTimersByTimeAsync(2_500)
			expect(mockCline.ask).not.toHaveBeenCalled()

			await callbacks.onCompleted!("hello\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS + 1_000)

			await handlePromise

			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("re-anchors a pending ask when execution start is reported after early output", async () => {
			vitest.useFakeTimers()
			mockCline.ask.mockResolvedValue({ response: "messageResponse", text: "keep going", images: undefined })
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 60")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			// Output arrives before the execution-started event (defensive case).
			await callbacks.onLine("working...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS - 2_000)
			callbacks.onShellExecutionStarted!(1234, proc)

			// The pending ask was rescheduled against the new anchor, so the old
			// deadline passing must not fire it.
			await vitest.advanceTimersByTimeAsync(2_500)
			expect(mockCline.ask).not.toHaveBeenCalled()

			// The ask must still fire at the re-anchored deadline — a version
			// that cleared the old timer without rescheduling would fail here.
			await vitest.advanceTimersByTimeAsync(2_500)
			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")

			// Let the command finish so the tool can resolve.
			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("cancels a pending ask when the agent timeout moves the command to the background", async () => {
			vitest.useFakeTimers()
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("npm run dev", 2)

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("server starting...\n", proc)

			// Agent timeout (2s) fires before the ask delay (5s).
			await vitest.advanceTimersByTimeAsync(2_000)
			expect(terminal.proc.continue).toHaveBeenCalled()
			expect(mockCline.supersedePendingAsk).toHaveBeenCalled()

			// Output after the background transition must never schedule an ask.
			await callbacks.onLine("listening...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS + 1_000)
			expect(mockCline.ask).not.toHaveBeenCalled()

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")
		})

		it("falls back to the command dispatch time when execution start is never reported", async () => {
			vitest.useFakeTimers()
			mockCline.ask.mockResolvedValue({ response: "messageResponse", text: "keep going", images: undefined })
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 60")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			// No onShellExecutionStarted: the pre-runCommand anchor applies.
			await callbacks.onLine("working...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS)

			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")

			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("swallows ask errors without failing the command", async () => {
			vitest.useFakeTimers()
			mockCline.ask.mockRejectedValue(new Error("Current ask promise was ignored"))
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 60")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("working...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS)

			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")
			expect(terminal.proc.continue).not.toHaveBeenCalled()

			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockPushToolResult.mock.calls[0][0]).toContain("Exit code: 0")
		})

		it("resolves before completion when the ask is answered without a message", async () => {
			// Note: in production only messageResponse answers reach a
			// command_output ask (Proceed/Kill route through terminalOperation);
			// yesButtonClicked is synthetic here to pin the non-message branch.
			vitest.useFakeTimers()
			mockCline.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 60")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("working...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS)

			// Any ask answer backgrounds the command: the process is continued and
			// the tool resolves without waiting for the command to complete.
			// Note the process promise is never resolved in this test.
			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise

			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")
			expect(terminal.proc.continue).toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockPushToolResult.mock.calls[0][0]).toContain("still running")

			// Cleanup: let the command finish.
			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
		})

		it("supersedes a pending ask when the command completes", async () => {
			vitest.useFakeTimers()
			mockCline.ask.mockReturnValue(new Promise(() => {}))
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("sleep 5")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess

			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("working...\n", proc)
			await vitest.advanceTimersByTimeAsync(executeCommandModule.COMMAND_OUTPUT_ASK_DELAY_MS)

			expect(mockCline.ask).toHaveBeenCalledWith("command_output", "")

			// The command completes while the ask is still pending.
			await callbacks.onCompleted!("working...\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)

			await handlePromise

			expect(mockCline.supersedePendingAsk).toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
			expect(mockPushToolResult.mock.calls[0][0]).toContain("Exit code: 0")
		})
	})
})
