// npx vitest run src/integrations/terminal/__tests__/TerminalProcess.spec.ts

import * as vscode from "vscode"

import { mergePromise } from "../mergePromise"
import { TerminalProcess } from "../TerminalProcess"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

class TestTerminalProcess extends TerminalProcess {
	public callTrimRetrievedOutput(): void {
		this.trimRetrievedOutput()
	}
}

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

describe("TerminalProcess", () => {
	let terminalProcess: TestTerminalProcess
	let mockTerminal: any
	type TestVscodeTerminal = vscode.Terminal & {
		shellIntegration: {
			executeCommand: any
		}
	}
	let mockTerminalInfo: Terminal
	let mockExecution: any
	let mockStream: AsyncIterableIterator<string>

	beforeEach(() => {
		// Create properly typed mock terminal
		mockTerminal = {
			shellIntegration: {
				executeCommand: vi.fn(),
			},
			name: "Roo Code",
			processId: Promise.resolve(123),
			creationOptions: {},
			exitStatus: undefined,
			state: { isInteractedWith: true },
			dispose: vi.fn(),
			hide: vi.fn(),
			show: vi.fn(),
			sendText: vi.fn(),
		} as unknown as TestVscodeTerminal

		mockTerminalInfo = new Terminal(1, mockTerminal, "./")

		// Create a process for testing
		terminalProcess = new TestTerminalProcess(mockTerminalInfo)
		mockTerminalInfo.process = terminalProcess

		TerminalRegistry["terminals"].push(mockTerminalInfo)

		// Reset event listeners
		terminalProcess.removeAllListeners()
	})

	describe("run", () => {
		it("emits no_shell_integration with commandSubmitted=false when shell integration startup times out", async () => {
			vi.useFakeTimers()
			const previousTimeout = Terminal.getShellIntegrationTimeout()
			Terminal.setShellIntegrationTimeout(10)

			try {
				mockTerminal.shellIntegration = undefined
				let commandSubmitted: boolean | undefined
				const runPromise = mockTerminalInfo.runCommand("test command", {
					onLine: vi.fn(),
					onCompleted: vi.fn(),
					onShellExecutionStarted: vi.fn(),
					onShellExecutionComplete: vi.fn(),
					onNoShellIntegration: (details) => {
						commandSubmitted = details.commandSubmitted
					},
				})

				await vi.advanceTimersByTimeAsync(20)
				await runPromise

				expect(commandSubmitted).toBe(false)
				expect(mockTerminal.sendText).not.toHaveBeenCalled()
			} finally {
				Terminal.setShellIntegrationTimeout(previousTimeout)
				vi.useRealTimers()
			}
		})

		it("handles shell integration commands correctly", async () => {
			let lines: string[] = []

			terminalProcess.on("completed", (output) => {
				if (output) {
					lines = output.split("\n")
				}
			})

			// Mock stream data with shell integration sequences.
			mockStream = (async function* () {
				yield "\x1b]633;C\x07" // The first chunk contains the command start sequence with bell character.
				yield "Initial output\n"
				yield "More output\n"
				yield "Final output"
				yield "\x1b]633;D\x07" // The last chunk contains the command end sequence with bell character.
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockExecution = {
				read: vi.fn().mockReturnValue(mockStream),
			}

			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			const runPromise = terminalProcess.run("test command")
			terminalProcess.emit("stream_available", mockStream)
			await runPromise

			expect(lines).toEqual(["Initial output", "More output", "Final output"])
			expect(terminalProcess.isHot).toBe(false)
		})

		it("wraps multiline POSIX scripts so VS Code tracks them as one shell execution", async () => {
			const command = 'PR_SHA=abc123\nfor f in one two; do\n  echo "$f @ $PR_SHA"\ndone'

			mockStream = (async function* () {
				yield "\x1b]633;C\x07"
				yield "one @ abc123\ntwo @ abc123\n"
				yield "\x1b]633;D\x07"
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockTerminal.shellIntegration.executeCommand.mockReturnValue({
				read: vi.fn().mockReturnValue(mockStream),
			})

			const runPromise = terminalProcess.run(command)
			terminalProcess.emit("stream_available", mockStream)
			await runPromise

			expect(mockTerminal.shellIntegration.executeCommand).toHaveBeenCalledWith(`{\n${command}\n}`)
		})

		it.each([
			["PowerShell", true, false, ". {\necho one\necho two\n}"],
			["fish", false, true, "begin\necho one\necho two\nend"],
		])("uses the %s multiline wrapper", async (_profile, isPowerShell, isFish, expectedCommand) => {
			const psSpy = vi.spyOn(Terminal, "isActiveShellPowerShell").mockReturnValue(isPowerShell)
			const fishSpy = vi.spyOn(Terminal, "isActiveShellFish").mockReturnValue(isFish)

			try {
				mockStream = (async function* () {
					yield "\x1b]633;C\x07"
					yield "one\ntwo\n"
					yield "\x1b]633;D\x07"
					terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
				})()

				mockTerminal.shellIntegration.executeCommand.mockReturnValue({
					read: vi.fn().mockReturnValue(mockStream),
				})

				const runPromise = terminalProcess.run("echo one\necho two")
				terminalProcess.emit("stream_available", mockStream)
				await runPromise

				expect(mockTerminal.shellIntegration.executeCommand).toHaveBeenCalledWith(expectedCommand)
			} finally {
				psSpy.mockRestore()
				fishSpy.mockRestore()
			}
		})

		it("handles terminals without shell integration", async () => {
			// Temporarily suppress the expected console.warn for this test
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(function () {})

			// Create a terminal without shell integration
			const noShellTerminal = {
				sendText: vi.fn(),
				shellIntegration: undefined,
				name: "No Shell Terminal",
				processId: Promise.resolve(456),
				creationOptions: {},
				exitStatus: undefined,
				state: { isInteractedWith: true },
				dispose: vi.fn(),
				hide: vi.fn(),
				show: vi.fn(),
			} as unknown as vscode.Terminal

			// Create new terminal info with the no-shell terminal
			const noShellTerminalInfo = new Terminal(2, noShellTerminal, "./")

			// Create new process with the no-shell terminal
			const noShellProcess = new TerminalProcess(noShellTerminalInfo)
			let commandSubmitted: boolean | undefined

			// Set up event listeners to verify events are emitted
			const eventPromises = Promise.all([
				new Promise<void>((resolve) =>
					noShellProcess.once("no_shell_integration", (details) => {
						commandSubmitted = details.commandSubmitted
						resolve()
					}),
				),
				new Promise<void>((resolve) => noShellProcess.once("completed", (_output?: string) => resolve())),
				new Promise<void>((resolve) => noShellProcess.once("continue", resolve)),
			])

			// Run command and wait for all events
			await noShellProcess.run("test command")
			await eventPromises

			// Verify sendText was called with the command
			expect(noShellTerminal.sendText).toHaveBeenCalledWith("test command", true)
			expect(commandSubmitted).toBe(true)

			// Restore the original console.warn
			consoleWarnSpy.mockRestore()
		})

		it("completes without warning when the execution stream is empty after submission", async () => {
			const noShellIntegrationSpy = vi.fn()
			let completedOutput: string | undefined

			const eventPromises = Promise.all([
				new Promise<void>((resolve) =>
					terminalProcess.once("completed", (output?: string) => {
						completedOutput = output
						resolve()
					}),
				),
				new Promise<void>((resolve) => terminalProcess.once("continue", resolve)),
			])

			async function* emptyStream(): AsyncGenerator<string> {
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
				return
				yield "" // satisfy require-yield; never reached
			}
			mockStream = emptyStream()

			mockExecution = { read: vi.fn().mockReturnValue(mockStream) }
			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			terminalProcess.once("no_shell_integration", noShellIntegrationSpy)

			const runPromise = terminalProcess.run("test command")
			await runPromise
			await eventPromises

			expect(mockExecution.read).toHaveBeenCalledTimes(1)
			expect(completedOutput).toBe("")
			expect(noShellIntegrationSpy).not.toHaveBeenCalled()
		})

		it("captures execution output even when VS Code does not include start markers", async () => {
			const noShellIntegrationSpy = vi.fn()
			let completedOutput: string | undefined

			const eventPromises = Promise.all([
				new Promise<void>((resolve) =>
					terminalProcess.once("completed", (output?: string) => {
						completedOutput = output
						resolve()
					}),
				),
				new Promise<void>((resolve) => terminalProcess.once("continue", resolve)),
			])

			mockStream = (async function* () {
				yield "some output without marker\n"
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockExecution = { read: vi.fn().mockReturnValue(mockStream) }
			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			terminalProcess.once("no_shell_integration", noShellIntegrationSpy)

			const runPromise = terminalProcess.run("test command")
			await runPromise
			await eventPromises

			expect(mockExecution.read).toHaveBeenCalledTimes(1)
			expect(completedOutput).toBe("some output without marker\n")
			expect(noShellIntegrationSpy).not.toHaveBeenCalled()
		})

		it("sets hot state for compiling commands", async () => {
			let lines: string[] = []

			terminalProcess.on("completed", (output) => {
				if (output) {
					lines = output.split("\n")
				}
			})

			const completePromise = new Promise<void>((resolve) => {
				terminalProcess.on("shell_execution_complete", () => resolve())
			})

			mockStream = (async function* () {
				yield "\x1b]633;C\x07" // The first chunk contains the command start sequence with bell character.
				yield "compiling...\n"
				yield "still compiling...\n"
				yield "done"
				yield "\x1b]633;D\x07" // The last chunk contains the command end sequence with bell character.
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockTerminal.shellIntegration.executeCommand.mockReturnValue({
				read: vi.fn().mockReturnValue(mockStream),
			})

			const runPromise = terminalProcess.run("npm run build")
			terminalProcess.emit("stream_available", mockStream)

			expect(terminalProcess.isHot).toBe(true)
			await runPromise

			expect(lines).toEqual(["compiling...", "still compiling...", "done"])

			await completePromise
			expect(terminalProcess.isHot).toBe(false)
		})
	})

	describe("continue", () => {
		it("stops listening and emits continue event", () => {
			const continueSpy = vi.fn()
			terminalProcess.on("continue", continueSpy)

			terminalProcess.continue()

			expect(continueSpy).toHaveBeenCalled()
			expect(terminalProcess["isListening"]).toBe(false)
		})
	})

	describe("abort", () => {
		// These MIRROR the private production constants in TerminalProcess.ts
		// (ABORT_RETRY_DELAY_MS and CTRL_C_SEND_LIMIT) — they can't be imported, so if
		// those values are ever tuned, update them here too or the timing assertions
		// below will keep passing while asserting the wrong cadence.
		const RETRY_DELAY_MS = 500 // mirrors ABORT_RETRY_DELAY_MS
		const MAX_ATTEMPTS = 3 // mirrors CTRL_C_SEND_LIMIT (total Ctrl+C sends)

		beforeEach(() => {
			vi.useFakeTimers()
			// abort() runs against the terminal's *current* process; mirror that wiring so
			// the reuse guard (terminal.process === this) lets the retry loop proceed.
			mockTerminalInfo.process = terminalProcess
		})

		afterEach(() => {
			vi.runOnlyPendingTimers()
			vi.useRealTimers()
		})

		it("sends a single Ctrl+C immediately and nothing else when the process exits (#266)", async () => {
			// Process exits right away: terminal is no longer busy.
			mockTerminalInfo.busy = false

			terminalProcess.abort()

			// Immediate Ctrl+C.
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(1)
			expect(mockTerminal.sendText).toHaveBeenCalledWith("\x03")

			// Advance past the whole retry window; no further Ctrl+C since not busy.
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * MAX_ATTEMPTS)
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(1)
		})

		it("re-sends Ctrl+C up to the bounded maximum while the process stays busy (#266)", async () => {
			// Process keeps ignoring SIGINT: terminal stays busy throughout.
			mockTerminalInfo.busy = true

			terminalProcess.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(1)

			// Each retry tick re-sends Ctrl+C while still busy, bounded by MAX_ATTEMPTS.
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * (MAX_ATTEMPTS + 2))

			expect(mockTerminal.sendText).toHaveBeenCalledTimes(MAX_ATTEMPTS)
			expect(mockTerminal.sendText).toHaveBeenCalledWith("\x03")
		})

		it("stops re-sending Ctrl+C once the process exits mid-retry (#266)", async () => {
			mockTerminalInfo.busy = true

			terminalProcess.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(1)

			// First retry tick: still busy, re-send.
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)

			// Process exits before the next tick — drive the real completion lifecycle
			// (shellExecutionComplete clears busy and releases terminal.process) rather than
			// mutating busy directly, so the test exercises the production wiring.
			mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * MAX_ATTEMPTS)

			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)
		})

		it("stops re-sending Ctrl+C if the terminal is reused for a different process (#266)", async () => {
			mockTerminalInfo.busy = true

			terminalProcess.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(1)

			// First retry tick: still busy, re-send.
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)

			// The original command exits and the terminal is reused for a NEW command before
			// the next tick: terminal stays busy, but terminal.process now points at a
			// different process. The retry must not interrupt that unrelated command.
			mockTerminalInfo.process = new TestTerminalProcess(mockTerminalInfo)
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * MAX_ATTEMPTS)

			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)
		})

		it("does nothing when the process is no longer listening (#266)", async () => {
			terminalProcess["isListening"] = false

			terminalProcess.abort()
			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * MAX_ATTEMPTS)

			expect(mockTerminal.sendText).not.toHaveBeenCalled()
		})

		it("does not start overlapping retry loops when abort() is called repeatedly (#266)", async () => {
			mockTerminalInfo.busy = true

			terminalProcess.abort()
			terminalProcess.abort()

			// Two immediate Ctrl+C from the two abort() calls, but only one retry loop.
			// This count of 2 relies on the `aborting` guard being checked AFTER the
			// immediate sendText in abort(): the second call still fires its own Ctrl+C
			// before the guard short-circuits the duplicate retry loop. If the guard ever
			// moves above the send, this would drop to 1 immediate send (total 3, not 4).
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)

			await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * (MAX_ATTEMPTS + 2))

			// 2 immediate + (MAX_ATTEMPTS - 1) retries from the single loop.
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2 + (MAX_ATTEMPTS - 1))
		})
	})

	describe("getUnretrievedOutput", () => {
		it("returns and clears unretrieved output", () => {
			terminalProcess["fullOutput"] = `\x1b]633;C\x07previous\nnew output\x1b]633;D\x07`
			terminalProcess["lastRetrievedIndex"] = 17 // After "previous\n"

			const unretrieved = terminalProcess.getUnretrievedOutput()
			expect(unretrieved).toBe("new output")

			expect(terminalProcess["lastRetrievedIndex"]).toBe(terminalProcess["fullOutput"].length - "previous".length)
		})
	})

	describe("interpretExitCode", () => {
		it("handles undefined exit code", () => {
			const result = TerminalProcess.interpretExitCode(undefined)
			expect(result).toEqual({ exitCode: undefined })
		})

		it("handles normal exit codes (0-128)", () => {
			const result = TerminalProcess.interpretExitCode(0)
			expect(result).toEqual({ exitCode: 0 })

			const result2 = TerminalProcess.interpretExitCode(1)
			expect(result2).toEqual({ exitCode: 1 })

			const result3 = TerminalProcess.interpretExitCode(128)
			expect(result3).toEqual({ exitCode: 128 })
		})

		it("interprets signal exit codes (>128)", () => {
			// SIGTERM (15) -> 128 + 15 = 143
			const result = TerminalProcess.interpretExitCode(143)
			expect(result).toEqual({
				exitCode: 143,
				signal: 15,
				signalName: "SIGTERM",
				coreDumpPossible: false,
			})

			// SIGSEGV (11) -> 128 + 11 = 139
			const result2 = TerminalProcess.interpretExitCode(139)
			expect(result2).toEqual({
				exitCode: 139,
				signal: 11,
				signalName: "SIGSEGV",
				coreDumpPossible: true,
			})
		})

		it("handles unknown signals", () => {
			const result = TerminalProcess.interpretExitCode(255)
			expect(result).toEqual({
				exitCode: 255,
				signal: 127,
				signalName: "Unknown Signal (127)",
				coreDumpPossible: false,
			})
		})
	})

	describe("trimRetrievedOutput", () => {
		it("clears buffer when all output has been retrieved", () => {
			// Set up a scenario where all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 16 // Same as fullOutput.length

			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("does not clear buffer when there is unretrieved output", () => {
			// Set up a scenario where not all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 5 // Less than fullOutput.length
			terminalProcess.callTrimRetrievedOutput()

			// Buffer should NOT be cleared - there's still unretrieved content
			expect(terminalProcess["fullOutput"]).toBe("test output data")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(5)
		})

		it("does nothing when buffer is already empty", () => {
			terminalProcess["fullOutput"] = ""
			terminalProcess["lastRetrievedIndex"] = 0
			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("clears buffer when lastRetrievedIndex exceeds fullOutput length", () => {
			// Edge case: index is greater than current length (could happen if output was modified)
			terminalProcess["fullOutput"] = "short"
			terminalProcess["lastRetrievedIndex"] = 100
			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})
	})

	describe("mergePromise", () => {
		it("merges promise methods with terminal process", async () => {
			const process = new TerminalProcess(mockTerminalInfo)
			const promise = Promise.resolve()

			const merged = mergePromise(process, promise)

			expect(merged).toHaveProperty("then")
			expect(merged).toHaveProperty("catch")
			expect(merged).toHaveProperty("finally")
			expect(merged instanceof TerminalProcess).toBe(true)

			await expect(merged).resolves.toBeUndefined()
		})
	})
})
