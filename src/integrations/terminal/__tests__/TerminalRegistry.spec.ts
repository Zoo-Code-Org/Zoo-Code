// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"
import { ExecaTerminal } from "../ExecaTerminal"
import { ShellIntegrationManager } from "../ShellIntegrationManager"
import { Terminal } from "../Terminal"
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
		let endHandler: (e: any) => Promise<void>

		beforeEach(() => {
			// Reset the initialized flag so we can call initialize() in this block.
			TerminalRegistry["isInitialized"] = false

			// The global vscode mock doesn't define shell execution event
			// methods, so add them before spying.
			;(vscode.window as any).onDidStartTerminalShellExecution ??= () => ({ dispose: () => {} })
			;(vscode.window as any).onDidEndTerminalShellExecution ??= () => ({ dispose: () => {} })

			vi.spyOn(vscode.window, "onDidStartTerminalShellExecution" as any).mockImplementation((_handler: any) => ({
				dispose: vi.fn(),
			}))

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
