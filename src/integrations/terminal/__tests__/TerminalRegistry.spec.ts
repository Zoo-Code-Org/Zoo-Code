// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

const PAGER = process.platform === "win32" ? "" : "cat"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

describe("TerminalRegistry", () => {
	let mockCreateTerminal: any

	beforeEach(() => {
		mockCreateTerminal = vi.spyOn(vscode.window, "createTerminal").mockImplementation(
			(...args: any[]) =>
				({
					exitStatus: undefined,
					name: "Roo Code",
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

	describe("createTerminal", () => {
		it("creates terminal with PAGER set appropriately for platform", () => {
			TerminalRegistry.createTerminal("/test/path", "vscode")

			expect(mockCreateTerminal).toHaveBeenCalledWith({
				cwd: "/test/path",
				name: "Roo Code",
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
					name: "Roo Code",
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
					name: "Roo Code",
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
					name: "Roo Code",
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
