// npx vitest run integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts

const mockPid = 12345
// Declared via vi.hoisted so they are available inside the hoisted vi.mock factory.
const { mockKill, mockSpawnSync, mockIterableFactory } = vitest.hoisted(() => ({
	mockKill: vitest.fn(),
	mockSpawnSync: vitest.fn().mockReturnValue({ status: 0 }),
	// Default iterable yields one line; tests can replace this to simulate errors.
	mockIterableFactory: { current: async function* () { yield "test output\n" } as () => AsyncGenerator<string> },
}))

vitest.mock("child_process", () => ({
	spawnSync: mockSpawnSync,
}))

vitest.mock("execa", () => {
	const execa = vitest.fn((options: any) => {
		return (_template: TemplateStringsArray, ...args: any[]) => ({
			pid: mockPid,
			iterable: (_opts: any) => mockIterableFactory.current(),
			kill: mockKill,
		})
	})
	return { execa, ExecaError: class extends Error {} }
})

import { execa } from "execa"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { BaseTerminal } from "../BaseTerminal"
import type { RooTerminal } from "../types"

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
		vitest.clearAllMocks()
	})

	describe("UTF-8 encoding fix", () => {
		it("should set LANG and LC_ALL to en_US.UTF-8", async () => {
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: true,
					cwd: "/test/cwd",
					all: true,
					detached: true,
					env: expect.objectContaining({
						LANG: "en_US.UTF-8",
						LC_ALL: "en_US.UTF-8",
					}),
				}),
			)
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

		it("should fall back to shell=true when execaShellPath is undefined", async () => {
			BaseTerminal.setExecaShellPath(undefined)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: true,
				}),
			)
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

	describe("abort", () => {
		it("kills the process group using a negative PID so child processes are not orphaned", async () => {
			const killSpy = vitest.spyOn(process, "kill").mockImplementation(() => true)

			// Start run() but abort before it resolves
			const runPromise = terminalProcess.run("sleep 30")
			// Yield so run() can set this.pid from the mock subprocess
			await Promise.resolve()
			terminalProcess.abort()
			await runPromise

			expect(killSpy).toHaveBeenCalledWith(-mockPid, "SIGKILL")
			killSpy.mockRestore()
		})

		it("emits exitCode 137 (SIGKILL) on abort", async () => {
			const killSpy = vitest.spyOn(process, "kill").mockImplementation(() => true)
			const completeSpy = vitest.fn()
			terminalProcess.on("shell_execution_complete", completeSpy)

			const runPromise = terminalProcess.run("sleep 30")
			await Promise.resolve()
			terminalProcess.abort()
			await runPromise

			expect(completeSpy).toHaveBeenCalledWith({ exitCode: 137, signalName: "SIGKILL" })
			killSpy.mockRestore()
		})

		it("falls back to subprocess.kill when process group kill throws", async () => {
			const killSpy = vitest.spyOn(process, "kill").mockImplementation(() => {
				throw new Error("ESRCH")
			})

			const runPromise = terminalProcess.run("sleep 30")
			await Promise.resolve()
			terminalProcess.abort()
			await runPromise

			// process.kill threw, so the fallback subprocess.kill must have been called
			expect(mockKill).toHaveBeenCalledWith("SIGKILL")
			killSpy.mockRestore()
		})

		it("does nothing when pid is not yet set", () => {
			const killSpy = vitest.spyOn(process, "kill").mockImplementation(() => true)
			// abort() before run() is called -- pid is undefined
			terminalProcess.abort()
			expect(killSpy).not.toHaveBeenCalled()
			killSpy.mockRestore()
		})

		it("emits exitCode 137 when the stream throws before the aborted flag is checked (race condition)", async () => {
			// Simulate the race: SIGKILL arrives and the iterable throws an ExecaError
			// before the for-await loop reads this.aborted and breaks cleanly.
			const { ExecaError } = await import("execa")
			const throwingError = Object.assign(new ExecaError(), { exitCode: null, signal: "SIGKILL", message: "killed" })
			mockIterableFactory.current = async function* () {
				throw throwingError
			}

			const killSpy = vitest.spyOn(process, "kill").mockImplementation(() => true)
			const completeSpy = vitest.fn()
			terminalProcess.on("shell_execution_complete", completeSpy)

			// abort() before run() resolves so this.aborted is true when the catch fires
			const runPromise = terminalProcess.run("sleep 30")
			await Promise.resolve()
			terminalProcess.abort()
			await runPromise

			expect(completeSpy).toHaveBeenCalledWith({ exitCode: 137, signalName: "SIGKILL" })

			// Restore default iterable for subsequent tests
			mockIterableFactory.current = async function* () { yield "test output\n" }
			killSpy.mockRestore()
		})
	})

	describe("abort (Windows)", () => {
		const isWindows = process.platform === "win32"
		const describeWindows = isWindows ? describe : describe.skip

		describeWindows("on win32", () => {
			it("kills the process tree via taskkill /F /T so child processes are not orphaned", async () => {
				const runPromise = terminalProcess.run("sleep 30")
				await Promise.resolve()
				terminalProcess.abort()
				await runPromise

				expect(mockSpawnSync).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", String(mockPid)])
			})

			it("falls back to subprocess.kill when taskkill throws", async () => {
				mockSpawnSync.mockImplementationOnce(() => { throw new Error("not found") })

				const runPromise = terminalProcess.run("sleep 30")
				await Promise.resolve()
				terminalProcess.abort()
				await runPromise

				expect(mockKill).toHaveBeenCalledWith("SIGKILL")
			})
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
})
