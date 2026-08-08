// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"

import { restoreGlobals } from "../../../test-utils/reset"
import { ExecaTerminal } from "../ExecaTerminal"
import { ShellIntegrationManager } from "../ShellIntegrationManager"
import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"
import { TerminalRegistry } from "../TerminalRegistry"
import { CommandScheduler } from "../CommandScheduler"
import type { RooTerminalProcess } from "../types"
import type { ResolvedCommandEnvironment } from "../shell/types"
import type { ShellInvocationPlan } from "../shell/types"

const PAGER = process.platform === "win32" ? "" : "cat"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

describe("TerminalRegistry", () => {
	let mockCreateTerminal: any
	let executionCounter = 0

	function nextExecutionId(): string {
		return `exec-${++executionCounter}`
	}

	beforeEach(() => {
		executionCounter = 0
		TerminalRegistry["terminals"] = []
		TerminalRegistry["nextTerminalId"] = 1
		TerminalRegistry["isInitialized"] = false
		CommandScheduler.cleanup()
		CommandScheduler.initialize()
		Terminal.setTerminalProfile(undefined)
		mockCreateTerminal = vi.spyOn(vscode.window, "createTerminal").mockImplementation(
			(...args: any[]) =>
				({
					exitStatus: undefined,
					name: "Zoo Code",
					processId: Promise.resolve(123),
					creationOptions: {},
					state: {
						isInteractedWith: true,
						shell: { id: "test-shell", executable: "/bin/bash", args: [] },
					},
					dispose: vi.fn(),
					hide: vi.fn(),
					show: vi.fn(),
					sendText: vi.fn(),
					shellIntegration: {
						executeCommand: vi.fn(),
					},
				}) as any,
		)
	})

	afterEach(() => {
		TerminalRegistry.cleanup()
		CommandScheduler.cleanup()
		TerminalRegistry["terminals"] = []
		TerminalRegistry["nextTerminalId"] = 1
		TerminalRegistry["isInitialized"] = false
		Terminal.setTerminalProfile(undefined)
		restoreGlobals()
	})

	describe("createTerminal", () => {
		it("creates terminal with PAGER set appropriately for platform", () => {
			TerminalRegistry.createTerminal("/test/path", "vscode")

			expect(mockCreateTerminal).toHaveBeenCalledWith({
				cwd: "/test/path",
				name: "Zoo Code",
				iconPath: expect.any(Object),
				env: {
					PAGER,
					ROO_ACTIVE: "true",
					VTE_VERSION: "0",
					PROMPT_EOL_MARK: "",
				},
			})
		})

		it("adds PROMPT_COMMAND when Terminal.getCommandDelay() > 0", () => {
			// Set command delay to 50ms for this test
			const originalDelay = Terminal.getCommandDelay()
			Terminal.setCommandDelay(50)

			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					cwd: "/test/path",
					name: "Zoo Code",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
						PROMPT_COMMAND: "sleep 0.05",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
					},
				})
			} finally {
				// Restore original delay
				Terminal.setCommandDelay(originalDelay)
			}
		})

		it("adds Oh My Zsh integration env var when enabled", () => {
			Terminal.setTerminalZshOhMy(true)
			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					cwd: "/test/path",
					name: "Zoo Code",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
						ITERM_SHELL_INTEGRATION_INSTALLED: "Yes",
					},
				})
			} finally {
				Terminal.setTerminalZshOhMy(false)
			}
		})

		it("adds Powerlevel10k integration env var when enabled", () => {
			Terminal.setTerminalZshP10k(true)
			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					cwd: "/test/path",
					name: "Zoo Code",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
						POWERLEVEL9K_TERM_SHELL_INTEGRATION: "true",
					},
				})
			} finally {
				Terminal.setTerminalZshP10k(false)
			}
		})
	})

	describe("getOrCreateTerminal", () => {
		it("reuses an idle VS Code terminal when the selected profile is unchanged", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()
			;((first as Terminal).terminal as any).shellIntegration = { executeCommand: vi.fn() }

			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(1)
		})

		it("creates a new VS Code terminal after changing from default to an override", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()

			Terminal.setTerminalProfile("Git Bash")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("creates a new VS Code terminal after changing from an override to default", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			Terminal.setTerminalProfile("Git Bash")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()

			Terminal.setTerminalProfile(undefined)
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("creates a new VS Code terminal after changing between named profiles", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			Terminal.setTerminalProfile("Git Bash")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()

			Terminal.setTerminalProfile("zsh")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("continues to reuse Execa terminals when the VS Code profile changes", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)

			Terminal.setTerminalProfile("Git Bash")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")

			expect(second).toBe(first)
		})
	})

	describe("atomic acquisition", () => {
		it("reserves a terminal before returning so it is not reused by a concurrent acquisition", async () => {
			const t1 = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			// t1 is still reserved; a second acquisition must create a new terminal.
			const t2 = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(t1).not.toBe(t2)
			expect(t1.lifecycle.ownerExecutionId).not.toBeUndefined()
			expect(t2.lifecycle.ownerExecutionId).not.toBeUndefined()
			expect(t1.lifecycle.ownerExecutionId).not.toBe(t2.lifecycle.ownerExecutionId)
		})

		it("serializes creation so only one terminal is created at a time", async () => {
			let concurrentCreations = 0
			let maxConcurrentCreations = 0

			const originalCreateTerminal = TerminalRegistry.createTerminal
			vi.spyOn(TerminalRegistry, "createTerminal").mockImplementation((cwd, provider, resolvedEnv) => {
				concurrentCreations++
				maxConcurrentCreations = Math.max(maxConcurrentCreations, concurrentCreations)
				const terminal = originalCreateTerminal.call(TerminalRegistry, cwd, provider, resolvedEnv)
				concurrentCreations--
				return terminal
			})

			await Promise.all([
				TerminalRegistry.getOrCreateTerminal("/a", "task", nextExecutionId(), "vscode"),
				TerminalRegistry.getOrCreateTerminal("/b", "task", nextExecutionId(), "vscode"),
				TerminalRegistry.getOrCreateTerminal("/c", "task", nextExecutionId(), "vscode"),
			])

			expect(maxConcurrentCreations).toBe(1)
		})
	})

	describe("health validation (REQ-005)", () => {
		it("does not reuse a VS Code terminal whose shell integration is absent", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()
			;((first as Terminal).terminal as any).shellIntegration = undefined

			const disposeSpy = vi.spyOn((first as Terminal).terminal, "dispose")
			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).not.toBe(first)
			expect(first.lifecycle.health).toBe("broken")
			expect(disposeSpy).toHaveBeenCalled()
			expect(cleanupSpy).toHaveBeenCalledWith(first.id)
		})

		it("reuses a healthy VS Code terminal with shell integration present", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)
			first.lifecycle.markHealthy()
			;((first as Terminal).terminal as any).shellIntegration = { executeCommand: vi.fn() }

			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "vscode")

			expect(second).toBe(first)
		})
	})

	describe("closeIdleTerminals", () => {
		it("disposes only idle VS Code terminals and cleans up their temporary zsh directories", () => {
			const idle = TerminalRegistry.createTerminal("/idle", "vscode") as Terminal
			const busy = TerminalRegistry.createTerminal("/busy", "vscode") as Terminal
			const execa = TerminalRegistry.createTerminal("/inline", "execa") as ExecaTerminal
			idle.lifecycle.resetToIdle()
			busy.busy = true
			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			TerminalRegistry.closeIdleTerminals()

			expect(idle.terminal.dispose).toHaveBeenCalledTimes(1)
			expect(cleanupSpy).toHaveBeenCalledWith(idle.id)
			expect(busy.terminal.dispose).not.toHaveBeenCalled()
			expect(TerminalRegistry["terminals"]).toEqual([busy, execa])
		})
	})

	describe("onDidEndTerminalShellExecution race condition (#489, #622)", () => {
		let startHandler: (e: any) => Promise<void>
		let endHandler: (e: any) => Promise<void>

		beforeEach(() => {
			// Reset the initialized flag so we can call initialize() in this block.
			TerminalRegistry["isInitialized"] = false

			// The global vscode mock doesn't define shell execution event
			// methods, so add them before spying.
			;(vscode.window as any).onDidStartTerminalShellExecution ??= () => ({ dispose: () => {} })
			;(vscode.window as any).onDidEndTerminalShellExecution ??= () => ({ dispose: () => {} })

			vi.spyOn(vscode.window, "onDidStartTerminalShellExecution" as any).mockImplementation((handler: any) => {
				startHandler = handler
				return { dispose: vi.fn() }
			})

			vi.spyOn(vscode.window, "onDidEndTerminalShellExecution" as any).mockImplementation((handler: any) => {
				endHandler = handler
				return { dispose: vi.fn() }
			})

			TerminalRegistry.initialize()
		})

		afterEach(() => {
			// Reset so other test blocks aren't affected.
			TerminalRegistry["isInitialized"] = false
		})

		it("calls shellExecutionComplete when end event fires before running is set (race)", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			const mockProcess = {
				command: "echo hello",
				emit: vi.fn(),
				hasUnretrievedOutput: vi.fn().mockReturnValue(false),
			} as any
			terminal.process = mockProcess

			// Simulate the race: running is still false (setActiveStream hasn't
			// been called yet), but the end event fires.
			expect(terminal.running).toBe(false)

			const mockExecution = { commandLine: { value: "echo hello" } }
			await endHandler({
				terminal: terminal.terminal,
				execution: mockExecution,
				exitCode: 0,
			})

			// shellExecutionComplete should have been called exactly once, emitting
			// shell_execution_complete so TerminalProcess.run() unblocks.
			expect(mockProcess.emit).toHaveBeenCalledWith(
				"shell_execution_complete",
				expect.objectContaining({ exitCode: 0 }),
			)
			expect(mockProcess.emit).toHaveBeenCalledTimes(1)

			// Terminal should be back to idle state.
			expect(terminal.busy).toBe(false)
			expect(terminal.running).toBe(false)
		})

		it("sets busy=false without calling shellExecutionComplete when no process exists", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.busy = true
			terminal.process = undefined
			const completeSpy = vi.spyOn(terminal, "shellExecutionComplete")

			expect(terminal.running).toBe(false)

			const mockExecution = { commandLine: { value: "echo hello" } }
			await endHandler({
				terminal: terminal.terminal,
				execution: mockExecution,
				exitCode: 0,
			})

			expect(terminal.busy).toBe(false)
			expect(completeSpy).not.toHaveBeenCalled()
		})

		it(
			"ignores a late end event for a superseded execution instead of completing " +
				"the next command on the same reused terminal",
			async () => {
				const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal

				// Command A: started, then self-finalized (e.g. TerminalProcess's own D-marker
				// grace period elapsed without ever seeing onDidEndTerminalShellExecution --
				// see TerminalProcess.ts's finalize()). Its own execution reference is what the
				// registry must compare against, since terminal.activeShellExecution may
				// already be pointing at a different (or no) execution by the time A's stale
				// event finally arrives.
				const processA = new TerminalProcess(terminal)
				const executionA = { commandLine: { value: "command A" } } as any
				processA.ownExecution = executionA
				const emitA = vi.spyOn(processA, "emit")

				// Command B has since started on the SAME reused terminal -- this is the
				// state TerminalRegistry sees by the time A's late event arrives: a live
				// process with its own, different execution.
				const processB = new TerminalProcess(terminal)
				const executionB = { commandLine: { value: "command B" } } as any
				processB.ownExecution = executionB
				terminal.process = processB
				terminal.running = true
				const emitB = vi.spyOn(processB, "emit")

				// A's end event finally arrives, referencing A's (now superseded) execution.
				await endHandler({
					terminal: terminal.terminal,
					execution: executionA,
					exitCode: 1,
				})

				// B must be completely unaffected: no shell_execution_complete delivered to
				// either process, and B is still the terminal's live process.
				expect(emitA).not.toHaveBeenCalled()
				expect(emitB).not.toHaveBeenCalled()
				expect(terminal.process).toBe(processB)
				expect(terminal.running).toBe(true)

				// B's own end event, referencing B's execution, must still work normally.
				await endHandler({
					terminal: terminal.terminal,
					execution: executionB,
					exitCode: 0,
				})

				expect(emitB).toHaveBeenCalledWith("shell_execution_complete", expect.objectContaining({ exitCode: 0 }))
			},
		)

		it("ignores a start event for a different (stale) execution and does not overwrite the stream", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal

			// processA owns executionA — this is the current, live command.
			const processA = new TerminalProcess(terminal)
			const executionA = { commandLine: { value: "command A" }, read: vi.fn() } as any
			processA.ownExecution = executionA
			terminal.process = processA
			const setStreamSpy = vi.spyOn(terminal, "setActiveStream")

			// A stale start event arrives referencing a *different* execution (executionB).
			// This can happen when VSCode fires a delayed start event for a prior terminal
			// session on the same reused terminal object.
			const executionB = { commandLine: { value: "stale command" }, read: vi.fn() } as any
			await startHandler({
				terminal: terminal.terminal,
				execution: executionB,
			})

			// The stale event must be ignored: read() must not be called on it and the
			// terminal's active stream must not be replaced.
			expect(executionB.read).not.toHaveBeenCalled()
			expect(setStreamSpy).not.toHaveBeenCalled()
		})

		it("sets the stream when the start event matches the process's own execution", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal

			const process = new TerminalProcess(terminal)
			const mockStream = (async function* () {})()
			const execution = { commandLine: { value: "echo hi" }, read: vi.fn().mockReturnValue(mockStream) } as any
			process.ownExecution = execution
			terminal.process = process
			terminal.lifecycle._setStateForTest("integration-ready", "exec-1")
			const setStreamSpy = vi.spyOn(terminal, "setActiveStream")

			await startHandler({
				terminal: terminal.terminal,
				execution,
			})

			expect(execution.read).toHaveBeenCalledTimes(1)
			expect(setStreamSpy).toHaveBeenCalledWith(mockStream)
			expect(terminal.busy).toBe(true)
		})
	})

	describe("watchdog (REQ-009)", () => {
		beforeEach(() => {
			TerminalRegistry["isInitialized"] = false
			;(vscode.window as any).onDidStartTerminalShellExecution ??= () => ({ dispose: () => {} })
			;(vscode.window as any).onDidEndTerminalShellExecution ??= () => ({ dispose: () => {} })
			vi.spyOn(vscode.window, "onDidStartTerminalShellExecution" as any).mockReturnValue({ dispose: vi.fn() })
			vi.spyOn(vscode.window, "onDidEndTerminalShellExecution" as any).mockReturnValue({ dispose: vi.fn() })
			TerminalRegistry.initialize()
		})

		afterEach(() => {
			TerminalRegistry["isInitialized"] = false
		})

		it("recovers a terminal that is owned but closed", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("creating", "exec-1")
			;(terminal.terminal as any).exitStatus = { code: 0 }

			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			TerminalRegistry["runWatchdog"]()

			expect(terminal.lifecycle.state).toBe("disposed")
			expect(cleanupSpy).toHaveBeenCalledWith(terminal.id)
			expect(TerminalRegistry["terminals"]).not.toContain(terminal)
		})

		it("recovers a terminal whose process belongs to a different execution", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("running", "exec-1")
			const mockProcess = { abort: vi.fn(), executionId: "exec-2" } as any
			terminal.process = mockProcess

			TerminalRegistry["runWatchdog"]()

			expect(terminal.lifecycle.state).toBe("disposed")
			expect(mockProcess.abort).toHaveBeenCalled()
		})

		it("recovers a pre-submission terminal that exceeded the deadline", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("creating", "exec-1")
			terminal.lifecycle._setStateChangedAtForTest(Date.now() - Terminal.getShellIntegrationTimeout() - 2_000)

			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			TerminalRegistry["runWatchdog"]()

			expect(terminal.lifecycle.state).toBe("disposed")
			expect(cleanupSpy).toHaveBeenCalledWith(terminal.id)
		})

		it("recovers a ready reservation that never reached submission", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("integration-ready", "exec-1")
			terminal.lifecycle._setStateChangedAtForTest(Date.now() - 11_000)

			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			TerminalRegistry["runWatchdog"]()

			expect(terminal.lifecycle.state).toBe("disposed")
			expect(cleanupSpy).toHaveBeenCalledWith(terminal.id)
		})

		it("does not recover a running terminal with a matching process", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("running", "exec-1")
			terminal.lifecycle._setStateChangedAtForTest(Date.now() - 60_000)
			terminal.process = { abort: vi.fn(), executionId: "exec-1" } as any

			TerminalRegistry["runWatchdog"]()

			expect(terminal.lifecycle.state).toBe("running")
			expect(terminal.process!.abort).not.toHaveBeenCalled()
		})
	})

	describe("provider-switch cleanup (REQ-008)", () => {
		it("removes and disposes the source VS Code terminal before acquiring the Execa fallback", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("creating", "exec-1")
			terminal.taskId = "task-1"

			const disposeSpy = vi.spyOn(terminal.terminal, "dispose")
			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			const fallbackPlan: ShellInvocationPlan = {
				executable: "/bin/bash",
				args: ["-c", ""],
				family: "posix",
				provider: "execa",
				env: {},
			}
			const resolvedEnv: ResolvedCommandEnvironment = {
				version: 1,
				primaryPlan: fallbackPlan,
				fallbackPlan,
				chainOperator: ";",
				promptDescriptor: {
					providerLabel: "Inline Terminal",
					shellFamilyLabel: "Bash",
					shellExecutableName: "bash",
					sourceLabel: "Test",
					isNonInteractive: true,
					supportsFishSyntax: false,
					supportsPosixSyntax: true,
				},
				warnings: [],
			}

			const result = await TerminalRegistry.prepareProviderSwitch({
				terminalId: terminal.id,
				executionId: "exec-1",
				fromProvider: "vscode",
				toProvider: "execa",
				reasonCode: "SI_NEVER_AVAILABLE",
				commandSubmitted: false,
				resolvedEnv,
			})

			// Source must be disposed before the fallback is acquired.
			expect(terminal.lifecycle.state).toBe("disposed")
			expect(disposeSpy).toHaveBeenCalled()
			expect(cleanupSpy).toHaveBeenCalledWith(terminal.id)
			expect(TerminalRegistry["terminals"]).not.toContain(terminal)

			// Fallback is an Execa terminal with the plan applied.
			expect(result.provider).toBe("execa")
			expect(result.terminal.provider).toBe("execa")
			expect(result.terminal.lifecycle.ownerExecutionId).toBe("exec-1")
			expect((result.terminal as ExecaTerminal).getShellInvocationPlan()).toBe(fallbackPlan)
		})

		it("refuses to switch when commandSubmitted is true", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode") as Terminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("running", "exec-1")
			terminal.lifecycle.markCommandSubmitted("exec-1")
			terminal.taskId = "task-1"
			terminal.process = { abort: vi.fn(), executionId: "exec-1" } as any

			const fallbackPlan: ShellInvocationPlan = {
				executable: "/bin/bash",
				args: ["-c", ""],
				family: "posix",
				provider: "execa",
				env: {},
			}
			const resolvedEnv: ResolvedCommandEnvironment = {
				version: 1,
				primaryPlan: fallbackPlan,
				fallbackPlan,
				chainOperator: ";",
				promptDescriptor: {
					providerLabel: "Inline Terminal",
					shellFamilyLabel: "Bash",
					shellExecutableName: "bash",
					sourceLabel: "Test",
					isNonInteractive: true,
					supportsFishSyntax: false,
					supportsPosixSyntax: true,
				},
				warnings: [],
			}

			const result = await TerminalRegistry.prepareProviderSwitch({
				terminalId: terminal.id,
				executionId: "exec-1",
				fromProvider: "vscode",
				toProvider: "execa",
				reasonCode: "POST_SUBMIT_REFUSED",
				commandSubmitted: true,
				resolvedEnv,
			})

			expect(result.provider).toBe("vscode")
			expect(result.terminal).toBe(terminal)
		})
	})

	describe("releaseTerminalsForTask", () => {
		it("aborts a busy terminal's running process and disassociates it from the task (#245)", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			const abort = vi.fn()
			terminal.taskId = "task-245"
			terminal.busy = true
			terminal.process = { abort } as any

			TerminalRegistry.releaseTerminalsForTask("task-245")

			expect(abort).toHaveBeenCalledTimes(1)
			expect(terminal.taskId).toBeUndefined()
		})

		it("does not abort an idle (not busy) terminal but still disassociates it", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			const abort = vi.fn()
			terminal.taskId = "task-idle"
			terminal.busy = false
			terminal.process = { abort } as any

			TerminalRegistry.releaseTerminalsForTask("task-idle")

			expect(abort).not.toHaveBeenCalled()
			expect(terminal.taskId).toBeUndefined()
		})

		it("only releases terminals belonging to the given task", () => {
			const a = TerminalRegistry.createTerminal("/a", "vscode")
			const b = TerminalRegistry.createTerminal("/b", "vscode")
			const abortA = vi.fn()
			const abortB = vi.fn()
			a.taskId = "task-A"
			a.busy = true
			a.process = { abort: abortA } as any
			b.taskId = "task-B"
			b.busy = true
			b.process = { abort: abortB } as any

			TerminalRegistry.releaseTerminalsForTask("task-A")

			expect(abortA).toHaveBeenCalledTimes(1)
			expect(a.taskId).toBeUndefined()
			expect(abortB).not.toHaveBeenCalled()
			expect(b.taskId).toBe("task-B")
		})

		it("swallows errors thrown by process.abort() and still disassociates the terminal", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			terminal.taskId = "task-throw"
			terminal.busy = true
			terminal.process = {
				abort: vi.fn(() => {
					throw new Error("boom")
				}),
			} as any

			expect(() => TerminalRegistry.releaseTerminalsForTask("task-throw")).not.toThrow()
			expect(terminal.taskId).toBeUndefined()
		})
	})

	describe("getTerminals", () => {
		it("filters by busy state and task id", () => {
			const busy = TerminalRegistry.createTerminal("/busy", "vscode")
			const idle = TerminalRegistry.createTerminal("/idle", "vscode")
			const otherTask = TerminalRegistry.createTerminal("/other", "vscode")
			busy.lifecycle.acquireOwner("exec-1")
			busy.lifecycle._setStateForTest("running", "exec-1")
			busy.taskId = "task-1"
			idle.lifecycle.resetToIdle()
			idle.taskId = "task-1"
			otherTask.lifecycle.resetToIdle()
			otherTask.taskId = "task-2"

			expect(TerminalRegistry.getTerminals(true, "task-1")).toEqual([busy])
			expect(TerminalRegistry.getTerminals(false, "task-1")).toEqual([idle])
			expect(TerminalRegistry.getTerminals(false)).toEqual([idle, otherTask])
		})
	})

	describe("getBackgroundTerminals", () => {
		it("returns only terminals without a task id", () => {
			const background = TerminalRegistry.createTerminal("/bg", "vscode")
			const owned = TerminalRegistry.createTerminal("/owned", "vscode")
			background.lifecycle.resetToIdle()
			background.taskId = undefined
			background.process = {
				hasUnretrievedOutput: vi.fn().mockReturnValue(true),
			} as unknown as RooTerminalProcess
			owned.lifecycle.resetToIdle()
			owned.taskId = "task-1"

			expect(TerminalRegistry.getBackgroundTerminals()).toEqual([background])
		})

		it("filters background terminals by busy state", () => {
			const busy = TerminalRegistry.createTerminal("/bg-busy", "vscode")
			const idle = TerminalRegistry.createTerminal("/bg-idle", "vscode")
			busy.lifecycle.acquireOwner("exec-1")
			busy.lifecycle._setStateForTest("running", "exec-1")
			idle.lifecycle.resetToIdle()

			expect(TerminalRegistry.getBackgroundTerminals(true)).toEqual([busy])
			expect(TerminalRegistry.getBackgroundTerminals(false)).toEqual([idle])
		})

		it("includes background terminals with unretrieved output when busy is undefined", () => {
			const withOutput = TerminalRegistry.createTerminal("/bg-output", "vscode")
			withOutput.lifecycle.resetToIdle()
			withOutput.process = {
				hasUnretrievedOutput: vi.fn().mockReturnValue(true),
			} as unknown as RooTerminalProcess

			expect(TerminalRegistry.getBackgroundTerminals()).toEqual([withOutput])
		})
	})

	describe("closeTerminalForCwd", () => {
		it("disposes only idle terminals matching cwd, task, and provider", () => {
			const match = TerminalRegistry.createTerminal("/match", "vscode") as Terminal
			const wrongCwd = TerminalRegistry.createTerminal("/other", "vscode") as Terminal
			const wrongTask = TerminalRegistry.createTerminal("/match", "vscode") as Terminal
			const busy = TerminalRegistry.createTerminal("/match", "vscode") as Terminal
			match.lifecycle.resetToIdle()
			match.taskId = "task-1"
			wrongCwd.lifecycle.resetToIdle()
			wrongCwd.taskId = "task-1"
			wrongTask.lifecycle.resetToIdle()
			wrongTask.taskId = "task-2"
			busy.lifecycle.acquireOwner("exec-1")
			busy.lifecycle._setStateForTest("running", "exec-1")
			busy.taskId = "task-1"

			const disposeSpy = vi.spyOn(match.terminal, "dispose")
			const cleanupSpy = vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir")

			TerminalRegistry.closeTerminalForCwd("/match", "task-1", "vscode")

			expect(disposeSpy).toHaveBeenCalledTimes(1)
			expect(cleanupSpy).toHaveBeenCalledWith(match.id)
			expect(TerminalRegistry["terminals"]).toEqual([wrongCwd, wrongTask, busy])
		})

		it("does not dispose Execa terminals but still removes them from the registry", () => {
			const execa = TerminalRegistry.createTerminal("/match", "execa") as ExecaTerminal
			execa.lifecycle.resetToIdle()
			execa.taskId = "task-1"

			TerminalRegistry.closeTerminalForCwd("/match", "task-1", "execa")

			expect(TerminalRegistry["terminals"]).not.toContain(execa)
		})
	})

	describe("getUnretrievedOutput and isProcessHot", () => {
		it("returns empty string for an unknown terminal id", () => {
			expect(TerminalRegistry.getUnretrievedOutput(999)).toBe("")
		})

		it("returns false for an unknown terminal id", () => {
			expect(TerminalRegistry.isProcessHot(999)).toBe(false)
		})

		it("returns the unretrieved output of the matching terminal", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			terminal.process = {
				isHot: true,
				hasUnretrievedOutput: vi.fn().mockReturnValue(true),
				getUnretrievedOutput: vi.fn().mockReturnValue("pending output"),
			} as unknown as RooTerminalProcess

			expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe("pending output")
			expect(TerminalRegistry.isProcessHot(terminal.id)).toBe(true)
		})
	})

	describe("Execa shell family reuse keying", () => {
		it("does not reuse an idle Execa terminal created with a different shell family", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)

			TerminalRegistry.setExecaShellFamily("powershell")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")

			expect(second).not.toBe(first)
		})

		it("reuses an idle Execa terminal when the shell family matches", async () => {
			TerminalRegistry.setExecaShellFamily("posix")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)

			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")

			expect(second).toBe(first)
		})

		it("does not reuse a family-keyed terminal after the family is cleared", async () => {
			TerminalRegistry.setExecaShellFamily("posix")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)

			// Clearing the family changes the reuse key from "execa:bash" back
			// to "execa", so the family-keyed terminal must not be reused.
			TerminalRegistry.setExecaShellFamily(undefined)
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")

			expect(second).not.toBe(first)
		})

		it("reuses a bare-key terminal after the family is cleared", async () => {
			TerminalRegistry.setExecaShellFamily(undefined)
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")
			first.lifecycle.resetToIdle()
			first.lifecycle.releaseOwner(first.lifecycle.ownerExecutionId!)

			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", nextExecutionId(), "execa")

			expect(second).toBe(first)
		})
	})

	describe("recoverStaleTerminal", () => {
		it("is a no-op when the terminal does not exist", () => {
			expect(() => TerminalRegistry.recoverStaleTerminal(999, "exec-1", "TERMINAL_BUSY_STALE")).not.toThrow()
		})

		it("skips recovery when the owner changed", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("running", "exec-1")
			const disposeSpy = vi.spyOn((terminal as Terminal).terminal, "dispose")

			TerminalRegistry.recoverStaleTerminal(terminal.id, "exec-2", "TERMINAL_BUSY_STALE")

			expect(disposeSpy).not.toHaveBeenCalled()
			expect(terminal.lifecycle.state).toBe("running")
		})

		it("resets an idle Execa terminal when no process is attached", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "execa") as ExecaTerminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("fallback-ready", "exec-1")
			terminal.taskId = "task-1"

			TerminalRegistry.recoverStaleTerminal(terminal.id, "exec-1", "TERMINAL_BUSY_STALE")

			expect(terminal.lifecycle.state).toBe("idle")
			expect(terminal.taskId).toBeUndefined()
		})

		it("aborts a stale process belonging to a different execution", () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "execa") as ExecaTerminal
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("running", "exec-1")
			const abort = vi.fn()
			terminal.process = { abort, executionId: "exec-2" } as unknown as RooTerminalProcess

			TerminalRegistry.recoverStaleTerminal(terminal.id, "exec-1", "TERMINAL_BUSY_STALE")

			expect(abort).toHaveBeenCalledTimes(1)
		})
	})

	describe("provider-switch validation errors", () => {
		const fallbackPlan: ShellInvocationPlan = {
			executable: "/bin/bash",
			args: ["-c", ""],
			family: "posix",
			provider: "execa",
			env: {},
		}
		const resolvedEnv: ResolvedCommandEnvironment = {
			version: 1,
			primaryPlan: fallbackPlan,
			fallbackPlan,
			chainOperator: ";",
			promptDescriptor: {
				providerLabel: "Inline Terminal",
				shellFamilyLabel: "Bash",
				shellExecutableName: "bash",
				sourceLabel: "Test",
				isNonInteractive: true,
				supportsFishSyntax: false,
				supportsPosixSyntax: true,
			},
			warnings: [],
		}

		it("rejects a non-vscode source provider", async () => {
			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: 1,
					executionId: "exec-1",
					fromProvider: "execa",
					toProvider: "execa",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv,
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/001")
		})

		it("rejects a non-execa target provider", async () => {
			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: 1,
					executionId: "exec-1",
					fromProvider: "vscode",
					toProvider: "vscode",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv,
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/002")
		})

		it("rejects when the fallback plan is missing", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("creating", "exec-1")

			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: terminal.id,
					executionId: "exec-1",
					fromProvider: "vscode",
					toProvider: "execa",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv: { ...resolvedEnv, fallbackPlan: undefined },
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/003")
		})

		it("rejects when the source terminal is not found", async () => {
			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: 999,
					executionId: "exec-1",
					fromProvider: "vscode",
					toProvider: "execa",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv,
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/004")
		})

		it("rejects when the source terminal is not a VS Code terminal", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "execa")
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("fallback-ready", "exec-1")

			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: terminal.id,
					executionId: "exec-1",
					fromProvider: "vscode",
					toProvider: "execa",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv,
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/005")
		})

		it("rejects when the owner execution does not match", async () => {
			const terminal = TerminalRegistry.createTerminal("/test/path", "vscode")
			terminal.lifecycle.acquireOwner("exec-1")
			terminal.lifecycle._setStateForTest("creating", "exec-1")

			await expect(
				TerminalRegistry.prepareProviderSwitch({
					terminalId: terminal.id,
					executionId: "exec-other",
					fromProvider: "vscode",
					toProvider: "execa",
					reasonCode: "SI_NEVER_AVAILABLE",
					commandSubmitted: false,
					resolvedEnv,
				}),
			).rejects.toThrow("TERMINAL/PROVIDER_SWITCH/006")
		})
	})

	describe("initialize guard", () => {
		it("throws when initialize is called twice", () => {
			TerminalRegistry["isInitialized"] = false
			const windowMock = vscode.window as unknown as Record<string, ReturnType<typeof vi.fn>>
			windowMock.onDidCloseTerminal = vi.fn().mockReturnValue({ dispose: vi.fn() })
			windowMock.onDidStartTerminalShellExecution = vi.fn().mockReturnValue({ dispose: vi.fn() })
			windowMock.onDidEndTerminalShellExecution = vi.fn().mockReturnValue({ dispose: vi.fn() })

			TerminalRegistry.initialize()
			expect(() => TerminalRegistry.initialize()).toThrow("should only be called once")
		})
	})
})
