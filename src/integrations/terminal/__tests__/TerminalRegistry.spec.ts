// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"
import { ExecaTerminal } from "../ExecaTerminal"
import { ShellIntegrationManager } from "../ShellIntegrationManager"
import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"
import { TerminalRegistry } from "../TerminalRegistry"

const PAGER = process.platform === "win32" ? "" : "cat"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

describe("TerminalRegistry", () => {
	let mockCreateTerminal: any

	beforeEach(() => {
		TerminalRegistry["terminals"] = []
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
		TerminalRegistry["terminals"] = []
		Terminal.setTerminalProfile(undefined)
		vi.restoreAllMocks()
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
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			expect(second).toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(1)
		})

		it("creates a new VS Code terminal after changing from default to an override", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			Terminal.setTerminalProfile("Git Bash")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("creates a new VS Code terminal after changing from an override to default", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			Terminal.setTerminalProfile("Git Bash")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			Terminal.setTerminalProfile(undefined)
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("creates a new VS Code terminal after changing between named profiles", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			Terminal.setTerminalProfile("Git Bash")
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			Terminal.setTerminalProfile("zsh")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "vscode")

			expect(second).not.toBe(first)
			expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
		})

		it("continues to reuse Execa terminals when the VS Code profile changes", async () => {
			const first = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "execa")

			Terminal.setTerminalProfile("Git Bash")
			const second = await TerminalRegistry.getOrCreateTerminal("/test/path", "task", "execa")

			expect(second).toBe(first)
		})
	})

	describe("closeIdleTerminals", () => {
		it("disposes only idle VS Code terminals and cleans up their temporary zsh directories", () => {
			const idle = TerminalRegistry.createTerminal("/idle", "vscode") as Terminal
			const busy = TerminalRegistry.createTerminal("/busy", "vscode") as Terminal
			const execa = TerminalRegistry.createTerminal("/inline", "execa") as ExecaTerminal
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
})
