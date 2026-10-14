// npx vitest run src/core/tools/__tests__/executeCommandTool.spec.ts

import type { ToolUsage } from "@roo-code/types"
import fs from "fs/promises"
import { constants as fsConstants, type Stats } from "fs"
import * as vscode from "vscode"

import { Task } from "../../task/Task"
import * as autoApprovalModule from "../../auto-approval"
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
		stat: vitest.fn().mockResolvedValue({ isDirectory: () => true }),
	},
}))

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn(),
	},
	// The Task module's real blanket-policy helpers load the editor decoration
	// controller, which builds a decoration type at import time.
	window: {
		createTextEditorDecorationType: vitest.fn().mockReturnValue({ dispose: vitest.fn() }),
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

// The handler calls `isBlanketDenyEngaged` and reads
// `BLANKET_DENY_AUTO_DENY_KINDS` from the Task module, so the blanket-policy
// helpers must stay real while the Task class itself stays a stub.
vitest.mock("../../task/Task", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../task/Task")>()
	return { ...actual, Task: vitest.fn() }
})
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

// Spies installed on the auto-approval module are not restored between tests,
// so a delegating spy must call the real policy captured at import time:
// capturing inside a test can capture another test's leaked spy and recurse.
const realCheckAutoApproval = autoApprovalModule.checkAutoApproval

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
			recordBlanketCommandDenial: vitest.fn(),
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

			// The DCG verdict is forwarded so checkAutoApproval auto-approves from
			// the verdict itself rather than inferring it from settings alone.
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, false, {
				dcgDecision: { decision: "allow" },
			})
			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("passes the DCG deny verdict unprotected when blanket auto-deny is engaged", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
				alwaysDenyUnapprovedCommands: true,
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
			})
			mockRunDcg.mockResolvedValue({ decision: "deny", reason: "matches a destructive pattern" })
			mockAskApproval.mockResolvedValue(false)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Blanket mode: not protected, so checkAutoApproval resolves the ask as
			// an automatic denial carrying the DCG reason instead of prompting.
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, false, {
				dcgDecision: { decision: "deny", reason: "matches a destructive pattern" },
			})
		})

		it("keeps the protected prompt when DCG denies and blanket auto-deny is off", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
				alwaysDenyUnapprovedCommands: false,
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
			})
			mockRunDcg.mockResolvedValue({ decision: "deny", reason: "matches a destructive pattern" })
			mockAskApproval.mockResolvedValue(false)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, true)
		})

		it("keeps the protected prompt when blanket auto-deny is on but command auto-approval is off", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
				alwaysDenyUnapprovedCommands: true,
				autoApprovalEnabled: false,
				alwaysAllowExecute: true,
			})
			mockRunDcg.mockResolvedValue({ decision: "deny", reason: "matches a destructive pattern" })
			mockAskApproval.mockResolvedValue(false)

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, true)
		})

		it("keeps the protected prompt when blanket auto-deny is on but execute auto-approval is off", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState.mockResolvedValue({
				destructiveCommandGuardEnabled: true,
				terminalShellIntegrationDisabled: true,
				alwaysDenyUnapprovedCommands: true,
				autoApprovalEnabled: true,
				alwaysAllowExecute: false,
			})
			mockRunDcg.mockResolvedValue({ decision: "deny", reason: "matches a destructive pattern" })
			mockAskApproval.mockResolvedValue(false)

			// Structural harness double — mockCline carries only the fields the handler reads; a typed Task is impractical.
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				// vi.fn stands in for the AskApproval signature; every test in this block uses this identical cast.
				askApproval: mockAskApproval as unknown as AskApproval,
				// vi.fn stands in for the HandleError signature; every test in this block uses this identical cast.
				handleError: mockHandleError as unknown as HandleError,
				// vi.fn stands in for the PushToolResult signature; every test in this block uses this identical cast.
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, true)
		})

		it("denies an approved command at execute time when blanket deny engages during the approval dwell", async () => {
			// The seconds-wide window: the approval rode on the pre-ask snapshot
			// taken with blanket deny off, and the engagement save lands before
			// the command reaches the terminal. The execute-time re-check must
			// deny instead of executing, and the blanket-kind denial must latch
			// the turn so the queue message this denial leaves cannot stand in
			// as approval for a later ask.
			const provider = await mockCline.providerRef.deref()
			provider.getState
				.mockResolvedValueOnce({
					alwaysDenyUnapprovedCommands: false,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					destructiveCommandGuardEnabled: false,
					terminalShellIntegrationDisabled: true,
				})
				.mockResolvedValue({
					alwaysDenyUnapprovedCommands: true,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					destructiveCommandGuardEnabled: false,
					terminalShellIntegrationDisabled: true,
				})
			mockAskApproval.mockResolvedValue(true)

			// The `as Task` cast is documentary — the harness double is `any`-typed,
			// so it and the `vi.fn` callbacks already satisfy the parameter types.
			await executeCommandTool.handle(mockCline as Task, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Position pin: the denial must arrive after an ask actually happened —
			// a pre-approval gate would deny without ever asking.
			expect(mockAskApproval).toHaveBeenCalledTimes(1)

			// Denied, not executed: the command never reaches the terminal.
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			expect(mockCline.recordBlanketCommandDenial).toHaveBeenCalledTimes(1)
			expect(formatResponse.toolAutoDenied).toHaveBeenCalledWith({
				reason: expect.stringContaining("not on the command allowlist"),
				offendingCommand: "echo test",
				ruleId: undefined,
			})
			expect(formatResponse.toolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
		})

		it("routes a guard flip during the approval dwell to a retryable error without latching", async () => {
			// The DCG setting flips on between approval and execution: the tool
			// holds no verdict for this command, so the fresh read denies with the
			// guard-state inconsistency. That is not a policy denial: the payload
			// stays a retryable tool error, and nothing latches — a re-issue
			// carrying a verdict may still execute.
			const provider = await mockCline.providerRef.deref()
			provider.getState
				.mockResolvedValueOnce({
					alwaysDenyUnapprovedCommands: true,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					destructiveCommandGuardEnabled: false,
					terminalShellIntegrationDisabled: true,
				})
				.mockResolvedValue({
					alwaysDenyUnapprovedCommands: true,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					destructiveCommandGuardEnabled: true,
					terminalShellIntegrationDisabled: true,
				})
			mockAskApproval.mockResolvedValue(true)

			await executeCommandTool.handle(mockCline as Task, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Same position pin as the sibling test: asked first, denied by the re-check.
			expect(mockAskApproval).toHaveBeenCalledTimes(1)
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			expect(mockCline.recordBlanketCommandDenial).not.toHaveBeenCalled()
			expect(formatResponse.toolAutoDenied).not.toHaveBeenCalled()
			expect(formatResponse.toolError).toHaveBeenCalledWith(expect.stringContaining("not a policy denial"))
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
		})

		// Shared scenario for the protected-prompt transition: the command is
		// DCG-denied with blanket auto-deny OFF, so the user sees the protected
		// prompt, explicitly approves it, and the blanket setting engages before
		// the command reaches the terminal.
		const setupProtectedDwellFlip = async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			provider.getState
				.mockResolvedValueOnce({
					destructiveCommandGuardEnabled: true,
					alwaysDenyUnapprovedCommands: false,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					terminalShellIntegrationDisabled: true,
				})
				.mockResolvedValue({
					destructiveCommandGuardEnabled: true,
					alwaysDenyUnapprovedCommands: true,
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: [],
					deniedCommands: [],
					terminalShellIntegrationDisabled: true,
				})
			mockRunDcg.mockResolvedValue({
				decision: "deny",
				reason: "matches a destructive pattern",
				ruleId: "recursive-delete",
			})
			// The user affirmatively approves the protected prompt during the dwell.
			mockAskApproval.mockResolvedValue(true)
			return provider
		}

		it("auto-denies a DCG-denied protected command when blanket deny engages during the approval dwell", async () => {
			await setupProtectedDwellFlip()

			await executeCommandTool.handle(mockCline, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// The prompt shown was the protected one — the blanket setting was off
			// when the ask was built.
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", undefined, true)

			// The blanket denial wins over the affirmative approval: the command
			// never reaches the terminal. The provider-level assertion is the
			// load-bearing one — it is the real execution boundary.
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			expect(mockCline.recordBlanketCommandDenial).toHaveBeenCalledTimes(1)
			expect(formatResponse.toolAutoDenied).toHaveBeenCalledWith({
				reason: expect.stringContaining("matches a destructive pattern"),
				offendingCommand: "echo test",
				ruleId: "recursive-delete",
			})
			expect(formatResponse.toolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
		})

		it("re-derives the recheck's protected flag from the fresh state instead of forwarding the latched prompt flag", async () => {
			await setupProtectedDwellFlip()
			const originalCheckAutoApproval = autoApprovalModule.checkAutoApproval
			const recheckSpy = vitest
				.spyOn(autoApprovalModule, "checkAutoApproval")
				.mockImplementation((args) => originalCheckAutoApproval(args))

			await executeCommandTool.handle(mockCline, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(recheckSpy).toHaveBeenCalledTimes(1)
			// The ask the user answered was protected, but protection is a property
			// of the policy that produced the prompt. Forwarding the latched flag
			// would make `checkAutoApproval` short-circuit to `ask` before ever
			// evaluating the now-engaged blanket denial.
			expect(recheckSpy).toHaveBeenCalledWith(expect.objectContaining({ ask: "command", isProtected: false }))
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		})

		it("fails closed when the execute-time recheck returns a non-approval other than deny", async () => {
			await setupProtectedDwellFlip()
			// The blanket-engaged command policy never answers `ask` today; force a
			// result from the permitted-but-unexpected tail of the union to pin that
			// any non-approval blocks execution instead of falling through.
			vitest.spyOn(autoApprovalModule, "checkAutoApproval").mockResolvedValue({ decision: "ask" })

			await executeCommandTool.handle(mockCline, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
			// Not a policy denial: no latch, and the retryable-error channel instead.
			expect(mockCline.recordBlanketCommandDenial).not.toHaveBeenCalled()
			expect(formatResponse.toolAutoDenied).not.toHaveBeenCalled()
			expect(formatResponse.toolError).toHaveBeenCalledWith(expect.stringContaining("instead of an approval"))
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
		})

		it("executes an allowlisted command when blanket deny stays engaged and the recheck approves", async () => {
			// The inverse of the dwell-flip denials: blanket deny is engaged on
			// both the ask-time snapshot and the fresh read, but the command
			// rides the allowlist, so the fresh policy still approves and the
			// execute-time re-check must fall through to execution — blanket
			// engagement alone is not a denial.
			const provider = await mockCline.providerRef.deref()
			provider.getState.mockResolvedValue({
				alwaysDenyUnapprovedCommands: true,
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["echo"],
				deniedCommands: [],
				destructiveCommandGuardEnabled: false,
				terminalShellIntegrationDisabled: true,
			})
			// The command auto-approves against this snapshot, so the ask resolves true.
			mockAskApproval.mockResolvedValue(true)
			const recheckSpy = vitest
				.spyOn(autoApprovalModule, "checkAutoApproval")
				.mockImplementation((args) => realCheckAutoApproval(args))

			await executeCommandTool.handle(mockCline as Task, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// The re-check genuinely ran against the fresh state — without this
			// pin the assertions below could pass with the re-check skipped.
			expect(recheckSpy).toHaveBeenCalledTimes(1)
			expect(recheckSpy).toHaveBeenCalledWith(expect.objectContaining({ ask: "command", isProtected: false }))

			// Approved: the command reaches the terminal and the pushed result is
			// the execution output, not a denial or a retryable error. The
			// TerminalRegistry assertion is the load-bearing one — the handler's
			// intra-module call to `executeCommandInTerminal` is not intercepted
			// by the spy, so the registry call is the real execution boundary.
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Command executed in terminal within working directory"),
			)
			expect(mockCline.recordBlanketCommandDenial).not.toHaveBeenCalled()
			expect(formatResponse.toolAutoDenied).not.toHaveBeenCalled()
			expect(formatResponse.toolError).not.toHaveBeenCalled()
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

		it("rejects a missing working directory before starting DCG", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			mockToolUse.params.cwd = "/missing/remote/workspace"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/missing/remote/workspace" }
			vi.mocked(fs.stat).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			vi.mocked(formatResponse.toolError).mockReturnValueOnce("formatted missing-directory error")

			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(formatResponse.toolError).toHaveBeenCalledExactlyOnceWith(
				"Working directory '/missing/remote/workspace' does not exist.",
			)
			expect(mockPushToolResult).toHaveBeenCalledExactlyOnceWith("formatted missing-directory error")
			expect(mockEnsureDcgInstalled).not.toHaveBeenCalled()
			expect(mockRunDcg).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockCline.didToolFailInCurrentTurn).toBe(true)
		})

		it("rejects an existing file used as the working directory", async () => {
			const provider = await mockCline.providerRef.deref()
			provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
			provider.contextProxy.getValue.mockReturnValue(true)
			mockToolUse.params.cwd = "/remote/workspace/file.txt"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/remote/workspace/file.txt" }
			vi.mocked(fs.stat).mockResolvedValueOnce({ isDirectory: () => false } as Stats)
			vi.mocked(formatResponse.toolError).mockReturnValueOnce("formatted not-a-directory error")
			await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(fs.stat).toHaveBeenCalledWith("/remote/workspace/file.txt")
			expect(fs.access).not.toHaveBeenCalled()
			expect(formatResponse.toolError).toHaveBeenCalledExactlyOnceWith(
				"Working directory '/remote/workspace/file.txt' is not a directory.",
			)
			expect(mockPushToolResult).toHaveBeenCalledExactlyOnceWith("formatted not-a-directory error")
			expect(mockEnsureDcgInstalled).not.toHaveBeenCalled()
			expect(mockRunDcg).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockCline.didToolFailInCurrentTurn).toBe(true)
		})

		it.each(["EACCES", "EPERM"])(
			"rejects a working directory without search permission (%s) before starting DCG",
			async (code) => {
				const provider = await mockCline.providerRef.deref()
				provider.context = { globalStorageUri: { fsPath: "/test/storage" } }
				provider.contextProxy.getValue.mockReturnValue(true)
				mockToolUse.params.cwd = "/remote/locked"
				mockToolUse.nativeArgs = { command: "echo test", cwd: "/remote/locked" }
				vi.mocked(fs.stat).mockResolvedValueOnce({ isDirectory: () => true } as Stats)
				vi.mocked(fs.access).mockRejectedValueOnce(Object.assign(new Error(code), { code }))
				vi.mocked(formatResponse.toolError).mockReturnValueOnce("formatted permission error")

				await executeCommandTool.handle(mockCline as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
				})

				expect(fs.access).toHaveBeenCalledWith("/remote/locked", fsConstants.X_OK)
				expect(formatResponse.toolError).toHaveBeenCalledExactlyOnceWith(
					"Working directory '/remote/locked' is not accessible (permission denied).",
				)
				expect(mockPushToolResult).toHaveBeenCalledExactlyOnceWith("formatted permission error")
				// Neither DCG nor the terminal (which starts only after approval) may start.
				expect(mockEnsureDcgInstalled).not.toHaveBeenCalled()
				expect(mockRunDcg).not.toHaveBeenCalled()
				expect(mockAskApproval).not.toHaveBeenCalled()
				expect(mockCline.didToolFailInCurrentTurn).toBe(true)
			},
		)

		it.each([
			[true, "stat", "EIO"],
			[true, "access", "ELOOP"],
			[false, "stat", "ELOOP"],
			[false, "access", "EIO"],
		] as const)(
			"preserves filesystem failures with DCG enabled=%s (%s, %s)",
			async (dcgEnabled, operation, code) => {
				const provider = await mockCline.providerRef.deref()
				provider.contextProxy.getValue.mockReturnValue(dcgEnabled)
				const message = `${code}: filesystem failure`
				vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error(message), { code }))
				const expected = `Unable to access working directory '/test/workspace': ${message}`
				if (dcgEnabled) vi.mocked(formatResponse.toolError).mockReturnValueOnce(expected)

				await executeCommandTool.handle(mockCline, mockToolUse, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
				})

				if (dcgEnabled) {
					expect(formatResponse.toolError).toHaveBeenCalledExactlyOnceWith(expected)
				}
				expect(mockPushToolResult).toHaveBeenCalledExactlyOnceWith(expected)
				expect(mockAskApproval).toHaveBeenCalledTimes(dcgEnabled ? 0 : 1)
				expect(mockEnsureDcgInstalled).not.toHaveBeenCalled()
				expect(mockRunDcg).not.toHaveBeenCalled()
				expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
				expect(mockCline.say).not.toHaveBeenCalledWith("shell_integration_warning")
				expect(mockHandleError).not.toHaveBeenCalled()
			},
		)

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

		it("honors a terminal shell integration flip made during a pending approval", async () => {
			vitest.useFakeTimers()
			const provider = await mockCline.providerRef.deref()
			// The pre-ask snapshot must not pin terminal behavior: execution
			// reads provider state again after approval and must honor the
			// fresher value.
			provider.getState
				.mockResolvedValueOnce({ terminalShellIntegrationDisabled: true })
				.mockResolvedValueOnce({ terminalShellIntegrationDisabled: false })
			vitest.spyOn(Terminal, "isActiveShellCmdExe").mockReturnValue(false)
			const terminal = await setupControllableTerminal()

			const handlePromise = handleCommand("Write-Output hello")

			await vitest.waitFor(() => expect(terminal.callbacks).toBeDefined())
			// A stale pre-ask snapshot would have selected "execa"; the post-approval
			// re-read sees shell integration enabled again and selects "vscode".
			expect(terminal.provider).toBe("vscode")

			const callbacks = terminal.callbacks!
			const proc = terminal.proc as unknown as RooTerminalProcess
			callbacks.onShellExecutionStarted!(1234, proc)
			await callbacks.onLine("hello\n", proc)
			await callbacks.onCompleted!("hello\n", proc)
			callbacks.onShellExecutionComplete!({ exitCode: 0 }, proc)
			terminal.resolveProcess()
			await vitest.advanceTimersByTimeAsync(100)
			await handlePromise

			expect(mockPushToolResult).toHaveBeenCalled()
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
	})
})
