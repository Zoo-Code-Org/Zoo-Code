// npx vitest run integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts

const { mockPid } = vi.hoisted(() => ({ mockPid: 12345 }))

vitest.mock("execa", () => {
	const mockKill = vitest.fn()

	const mockSubprocess = {
		pid: mockPid,
		iterable: (_opts: any) =>
			(async function* () {
				yield "test output\n"
			})(),
		kill: mockKill,
	}

	// Support both forms:
	// 1. execa(executable, args, options) — new plan-based path
	// 2. execa(options)`cmd` — legacy tagged template path
	const execa = vitest.fn(function (executableOrOptions: any, args?: any, options?: any) {
		// If called as execa(executable, args, options) — 3-arg form
		if (args !== undefined && options !== undefined) {
			return mockSubprocess
		}
		// If called as execa(options) — returns a function for tagged template
		// The tagged template form calls the returned function with (template, ...expressions)
		return (_template: TemplateStringsArray, ..._expressions: any[]) => mockSubprocess
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
import { BaseTerminal } from "../BaseTerminal"
import type { RooTerminal } from "../types"
import type { ShellInvocationPlan } from "../shell/types"

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
			lifecycle: {
				resetToIdle: vitest.fn(),
				state: "idle",
			},
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

	// -------------------------------------------------
	// Plan-based execution (new ShellInvocationPlan path)
	// -------------------------------------------------

	describe("plan-based execution", () => {
		function makePlan(overrides: Partial<ShellInvocationPlan> = {}): ShellInvocationPlan {
			return {
				executable: "/bin/bash",
				args: ["-c", ""], // command placeholder, replaced at runtime
				family: "posix",
				cwd: "/test/cwd",
				env: {},
				provider: "execa",
				...overrides,
			}
		}

		it("should call execa with explicit executable and args when plan is provided", async () => {
			const plan = makePlan({
				executable: "/bin/bash",
				args: ["-c", ""],
				family: "posix",
			})
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				"/bin/bash",
				["-c", "echo test"],
				expect.objectContaining({
					cwd: "/test/cwd",
					all: true,
					stdin: "ignore",
				}),
			)
		})

		it("should NOT use shell: true when plan is provided", async () => {
			const plan = makePlan()
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			const callArgs = execaMock.mock.calls[0] as any[]
			// execa(executable, args, options) — options is third arg
			const options = callArgs[2]
			expect(options).not.toHaveProperty("shell")
			expect(options.shell).toBeUndefined()
		})

		it("should set LANG and LC_ALL to en_US.UTF-8 when plan is provided", async () => {
			const plan = makePlan()
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			const options = (execaMock.mock.calls[0] as any[])[2]
			expect(options.env.LANG).toBe("en_US.UTF-8")
			expect(options.env.LC_ALL).toBe("en_US.UTF-8")
		})

		it("should preserve existing environment variables when plan is provided", async () => {
			process.env.EXISTING_VAR = "existing"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			const plan = makePlan()
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			const options = (execaMock.mock.calls[0] as any[])[2]
			expect(options.env.EXISTING_VAR).toBe("existing")
		})

		it("should override existing LANG and LC_ALL values when plan is provided", async () => {
			process.env.LANG = "C"
			process.env.LC_ALL = "POSIX"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			const plan = makePlan()
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			const options = (execaMock.mock.calls[0] as any[])[2]
			expect(options.env.LANG).toBe("en_US.UTF-8")
			expect(options.env.LC_ALL).toBe("en_US.UTF-8")
		})

		it("should merge plan env into process env", async () => {
			const plan = makePlan({
				env: { CUSTOM_VAR: "custom_value" },
			})
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			const options = (execaMock.mock.calls[0] as any[])[2]
			expect(options.env.CUSTOM_VAR).toBe("custom_value")
		})

		it("should replace the last arg with the actual command", async () => {
			const plan = makePlan({
				executable: "C:\\Windows\\System32\\cmd.exe",
				args: ["/d", "/s", "/c", ""],
				family: "cmd",
			})
			await terminalProcess.run("dir C:\\", plan)

			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				"C:\\Windows\\System32\\cmd.exe",
				["/d", "/s", "/c", "dir C:\\"],
				expect.any(Object),
			)
		})

		it("should produce correct executable + args for PowerShell family", async () => {
			const plan = makePlan({
				executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ""],
				family: "powershell",
			})
			await terminalProcess.run("Get-Process", plan)

			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Process"],
				expect.any(Object),
			)
		})

		it("should produce correct executable + args for fish family", async () => {
			const plan = makePlan({
				executable: "/usr/bin/fish",
				args: ["--no-config", "-c", ""],
				family: "fish",
			})
			await terminalProcess.run("echo test", plan)

			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				"/usr/bin/fish",
				["--no-config", "-c", "echo test"],
				expect.any(Object),
			)
		})

		it("should produce correct executable + args for WSL family", async () => {
			const plan = makePlan({
				executable: "C:\\Windows\\System32\\wsl.exe",
				args: ["--distribution", "Ubuntu", "--exec", "/bin/bash", "-c", ""],
				family: "wsl",
			})
			await terminalProcess.run("ls -la", plan)

			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				"C:\\Windows\\System32\\wsl.exe",
				["--distribution", "Ubuntu", "--exec", "/bin/bash", "-c", "ls -la"],
				expect.any(Object),
			)
		})
	})

	// -------------------------------------------------
	// Legacy fallback (no plan provided)
	// -------------------------------------------------

	describe("legacy fallback (no plan)", () => {
		it("should fall back to shell=true when no plan is provided", async () => {
			await terminalProcess.run("echo test")

			const execaMock = vitest.mocked(execa)
			const callArgs = execaMock.mock.calls[0]
			// Legacy form: execa(options)`cmd` — first arg is options object
			const options = callArgs[0] as any
			expect(options.shell).toBe(true)
		})

		it("should use execaShellPath when set and no plan is provided", async () => {
			BaseTerminal.setExecaShellPath("/bin/bash")
			await terminalProcess.run("echo test")

			const execaMock = vitest.mocked(execa)
			const callArgs = execaMock.mock.calls[0]
			const options = callArgs[0] as any
			expect(options.shell).toBe("/bin/bash")
		})

		it("should set LANG and LC_ALL in legacy fallback", async () => {
			await terminalProcess.run("echo test")

			const execaMock = vitest.mocked(execa)
			const options = execaMock.mock.calls[0][0] as any
			expect(options.env.LANG).toBe("en_US.UTF-8")
			expect(options.env.LC_ALL).toBe("en_US.UTF-8")
		})
	})

	// -------------------------------------------------
	// Basic functionality (unchanged)
	// -------------------------------------------------

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
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 16
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("does not clear buffer when there is unretrieved output", () => {
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 5
			;(terminalProcess as any).trimRetrievedOutput()

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
			terminalProcess["fullOutput"] = "short"
			terminalProcess["lastRetrievedIndex"] = 100
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})
	})
})
