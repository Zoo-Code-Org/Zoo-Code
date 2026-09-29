// npx vitest run integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts

const mockPid = 12345

vitest.mock("execa", () => {
	const mockKill = vitest.fn()
	const execa = vitest.fn(function (options: any) {
		return (_template: TemplateStringsArray, ...args: any[]) => ({
			pid: mockPid,
			iterable: (_opts: any) =>
				(async function* () {
					yield "test output\n"
				})(),
			kill: mockKill,
		})
	})
	return { execa, ExecaError: class extends Error {} }
})

vitest.mock("ps-tree", () => ({
	default: vitest.fn(function (_: number, cb: any) {
		return cb(null, [])
	}),
}))

import { execa } from "execa"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import * as shellUtils from "../../../utils/shell"
import { BaseTerminal } from "../BaseTerminal"
import type { RooTerminal } from "../types"

import { clearAllMocks } from "../../../test-utils/reset"

describe("ExecaTerminalProcess", () => {
	let mockTerminal: RooTerminal
	let terminalProcess: ExecaTerminalProcess
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		originalEnv = { ...process.env }
		BaseTerminal.setExecaShellPath(undefined)
		mockTerminal = {
			provider: "execa",
			id: 1,
			busy: false,
			running: false,
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/cwd"),
			isClosed: vitest.fn().mockReturnValue(false),
			runCommand: vitest.fn(),
			setActiveStream: vitest.fn(),
			shellExecutionComplete: vitest.fn(),
			getProcessesWithOutput: vitest.fn().mockReturnValue([]),
			getUnretrievedOutput: vitest.fn().mockReturnValue(""),
			getLastCommand: vitest.fn().mockReturnValue(""),
			cleanCompletedProcessQueue: vitest.fn(),
		} as unknown as RooTerminal
		terminalProcess = new ExecaTerminalProcess(mockTerminal)
	})

	afterEach(() => {
		process.env = originalEnv
		clearAllMocks()
	})

	describe("UTF-8 encoding fix", () => {
		/**
		 * Clears the locale variables so the assertion does not depend on the locale of the
		 * machine (or CI runner) that executes the test.
		 */
		const clearLocaleVariables = () => {
			delete process.env.LANG
			delete process.env.LC_ALL
			delete process.env.LC_CTYPE
		}

		it("should set LANG and LC_ALL to en_US.UTF-8", async () => {
			// Deterministic shell so the assertion focuses solely on LANG/LC_ALL.
			vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
			clearLocaleVariables()
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: "/bin/zsh",
					cwd: "/test/cwd",
					all: true,
					env: expect.objectContaining({
						LANG: "en_US.UTF-8",
						LC_ALL: "en_US.UTF-8",
					}),
				}),
			)
		})

		it("preserves an inherited UTF-8 locale instead of forcing en_US.UTF-8 (#1084)", async () => {
			process.env.LANG = "en_AU.UTF-8"
			delete process.env.LC_ALL
			delete process.env.LC_CTYPE
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			const calledOptions = execaMock.mock.calls[0][0] as unknown as { env: NodeJS.ProcessEnv }
			expect(calledOptions.env.LANG).toBe("en_AU.UTF-8")
			expect(calledOptions.env.LC_ALL).toBeUndefined()
		})

		it("should preserve existing environment variables", async () => {
			process.env.EXISTING_VAR = "existing"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			const calledOptions = execaMock.mock.calls[0][0] as any
			expect(calledOptions.env.EXISTING_VAR).toBe("existing")
		})

		it("should override existing LANG and LC_ALL values", async () => {
			// "C" and "POSIX" select ASCII, not UTF-8, so the UTF-8 fallback still applies.
			process.env.LANG = "C"
			process.env.LC_ALL = "POSIX"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			const calledOptions = execaMock.mock.calls[0][0] as any
			expect(calledOptions.env.LANG).toBe("en_US.UTF-8")
			expect(calledOptions.env.LC_ALL).toBe("en_US.UTF-8")
		})

		it("should use execaShellPath when set", async () => {
			BaseTerminal.setExecaShellPath("/bin/bash")
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: "/bin/bash",
				}),
			)
		})

		it("when execaShellPath is unset, Execa resolves through getShell() (never shell:true)", async () => {
			BaseTerminal.setExecaShellPath(undefined)
			const resolved = "/resolved/pwsh.exe"
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue(resolved)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: resolved,
				}),
			)
			expect(execaMock).not.toHaveBeenCalledWith(expect.objectContaining({ shell: true }))
		})
	})

	describe("basic functionality", () => {
		it("should create instance with terminal reference", () => {
			expect(terminalProcess).toBeInstanceOf(ExecaTerminalProcess)
			expect(terminalProcess.terminal).toBe(mockTerminal)
		})

		it("should emit shell_execution_complete with exitCode 0", async () => {
			const spy = vitest.fn()
			terminalProcess.on("shell_execution_complete", spy)
			await terminalProcess.run("echo test")
			expect(spy).toHaveBeenCalledWith({ exitCode: 0 })
		})

		it("should emit completed event with full output", async () => {
			const spy = vitest.fn()
			terminalProcess.on("completed", spy)
			await terminalProcess.run("echo test")
			expect(spy).toHaveBeenCalledWith("test output\n")
		})

		it("should set and clear active stream", async () => {
			await terminalProcess.run("echo test")
			expect(mockTerminal.setActiveStream).toHaveBeenCalledWith(expect.any(Object), mockPid)
			expect(mockTerminal.setActiveStream).toHaveBeenLastCalledWith(undefined)
		})
	})

	describe("trimRetrievedOutput", () => {
		it("clears buffer when all output has been retrieved", () => {
			// Set up a scenario where all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 16 // Same as fullOutput.length

			// Access the protected method through type casting
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("does not clear buffer when there is unretrieved output", () => {
			// Set up a scenario where not all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 5 // Less than fullOutput.length
			;(terminalProcess as any).trimRetrievedOutput()

			// Buffer should NOT be cleared - there's still unretrieved content
			expect(terminalProcess["fullOutput"]).toBe("test output data")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(5)
		})

		it("does nothing when buffer is already empty", () => {
			terminalProcess["fullOutput"] = ""
			terminalProcess["lastRetrievedIndex"] = 0
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("clears buffer when lastRetrievedIndex exceeds fullOutput length", () => {
			// Edge case: index is greater than current length (could happen if output was modified)
			terminalProcess["fullOutput"] = "short"
			terminalProcess["lastRetrievedIndex"] = 100
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})
	})

	describe("cross-path shell invariant (#705 regression)", () => {
		// Bridge through unknown: the mock records the raw options object, whose
		// declared type under execa's overloads is string|URL, not a plain record.
		const capturedShellOption = (): Record<string, string | boolean> =>
			vitest.mocked(execa).mock.calls[0][0] as unknown as Record<string, string | boolean>

		beforeEach(() => {
			BaseTerminal.setExecaShellPath(undefined)
		})

		it("system-prompt resolved shell == Execa execution shell when no explicit execaShellPath", async () => {
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
			await terminalProcess.run("echo test")
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(capturedShellOption().shell).toBe("/bin/zsh")
		})

		it("keeps the Execa shell equal to getShell() when a Zoo profile override is set", async () => {
			BaseTerminal.setExecaShellPath(undefined)
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\pwsh.exe")
			await terminalProcess.run("echo test")
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(capturedShellOption().shell).toBe("C:\\Windows\\System32\\pwsh.exe")
		})

		it("uses PowerShell when VS Code resolves PowerShell and execaShellPath is unset", async () => {
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue("powershell.exe")
			await terminalProcess.run("echo test")
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(capturedShellOption().shell).toBe("powershell.exe")
		})

		it("preserves a deliberately selected Command Prompt profile when execaShellPath is unset", async () => {
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue("cmd.exe")
			await terminalProcess.run("echo test")
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(capturedShellOption().shell).toBe("cmd.exe")
		})

		it("does NOT delegate to shell:true even when getShell() returns an unusual path", async () => {
			const getShellSpy = vi.spyOn(shellUtils, "getShell").mockReturnValue("/opt/custom/fish")
			await terminalProcess.run("echo test")
			expect(getShellSpy).toHaveBeenCalledTimes(1)
			expect(capturedShellOption().shell).not.toBe(true)
			expect(capturedShellOption().shell).toBe("/opt/custom/fish")
		})
	})
})
