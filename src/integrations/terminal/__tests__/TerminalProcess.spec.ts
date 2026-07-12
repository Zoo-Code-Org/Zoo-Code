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
			})()

			mockExecution = {
				read: vi.fn().mockReturnValue(mockStream),
			}

			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			const runPromise = terminalProcess.run("test command")
			terminalProcess.emit("stream_available", mockStream)

			// onDidEndTerminalShellExecution is a separate global VSCode event, not
			// something coupled to the stream iterator being pulled again -- emit it
			// independently of stream consumption, matching real-world timing.
			// Use setTimeout(0) so it fires after microtask-based stream processing
			// (async generator iterations) has consumed all chunks including the D marker.
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await runPromise

			expect(lines).toEqual(["Initial output", "More output", "Final output"])
			expect(terminalProcess.isHot).toBe(false)
		})

		it(
			"completes promptly when the D marker arrives but the stream never closes and " +
				"onDidEndTerminalShellExecution never fires (VSCode #316556 / #250764)",
			async () => {
				let lines: string[] = []
				let completedOutput: string | undefined

				terminalProcess.on("completed", (output) => {
					completedOutput = output
					if (output) {
						lines = output.split("\n")
					}
				})

				// Simulate the confirmed real-world hang: the shell writes the D marker
				// (command output is fully visible), but the stream's async iterator never
				// signals `done: true` afterward, and the global onDidEndTerminalShellExecution
				// event never fires. Model this with a stream that yields the D marker and
				// then never resolves any further -- exactly what "never closes" looks like.
				let hangForever: () => void = () => {}
				mockStream = (async function* () {
					yield "\x1b]633;C\x07"
					yield "some output\n"
					yield "\x1b]633;D\x07"
					// The generator never returns past this point -- the next `.next()` call
					// (which would happen if the loop kept consuming) hangs forever, and no
					// `shell_execution_complete` event is ever emitted.
					await new Promise<void>((resolve) => {
						hangForever = resolve
					})
				})()

				mockExecution = {
					read: vi.fn().mockReturnValue(mockStream),
				}

				mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

				const runPromise = terminalProcess.run("test command")
				terminalProcess.emit("stream_available", mockStream)

				// No shell_execution_complete is ever emitted here -- the fix must not
				// depend on it to unblock once the D marker has been seen.
				await runPromise

				expect(lines).toEqual(["some output", ""])
				expect(completedOutput).toBe("some output\n")
				expect(terminalProcess.isHot).toBe(false)

				// Clean up the still-pending generator await so it doesn't leak between tests.
				hangForever()
			},
		)

		it("does not complete a long-running, silent command until it actually produces the D marker or closes", async () => {
			// A bare `sleep 60`-style command: prints the start marker and then genuinely
			// nothing else for a long time because it is still running, not because VSCode
			// lost the signal. There is no idle-timeout guessing -- run() simply keeps
			// waiting on the stream, exactly like a real long-running command should.
			let completedFired = false

			terminalProcess.on("completed", () => {
				completedFired = true
			})

			// Signals once the generator has actually reached its suspension point (i.e.
			// once run()'s `for await` loop has consumed the first chunk and is genuinely
			// waiting on the stream for the next one), so the test can assert "not yet
			// completed" and then resume deterministically, instead of guessing how many
			// microtask turns run()'s internal await chain (streamAvailable, etc.) needs.
			let releaseStream: () => void = () => {}
			let notifySuspended: () => void = () => {}
			const suspended = new Promise<void>((resolve) => {
				notifySuspended = resolve
			})

			mockStream = (async function* () {
				yield "\x1b]633;C\x07"
				notifySuspended()
				await new Promise<void>((resolve) => {
					releaseStream = resolve
				})
				yield "finally done\n"
				yield "\x1b]633;D\x07"
			})()

			mockExecution = {
				read: vi.fn().mockReturnValue(mockStream),
			}

			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			const runPromise = terminalProcess.run("sleep 60")
			terminalProcess.emit("stream_available", mockStream)

			// Wait until the generator has genuinely suspended waiting for more input;
			// it must still be waiting on the stream at this point, not completed.
			await suspended
			expect(completedFired).toBe(false)

			// The command finally finishes. Emit shell_execution_complete directly (as
			// onDidEndTerminalShellExecution normally would) so run() doesn't need to wait
			// out its 1s D-marker grace period for this assertion to be deterministic.
			releaseStream()
			terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			await runPromise

			expect(completedFired).toBe(true)
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
			// stream_available is now emitted by TerminalRegistry (onDidStartTerminalShellExecution).
			// Simulate that here so run() can proceed to consume the stream.
			terminalProcess.emit("stream_available", mockStream)
			await runPromise
			await eventPromises

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
			// stream_available is now emitted by TerminalRegistry (onDidStartTerminalShellExecution).
			// Simulate that here so run() can proceed to consume the stream.
			terminalProcess.emit("stream_available", mockStream)
			await runPromise
			await eventPromises

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
			})()

			mockTerminal.shellIntegration.executeCommand.mockReturnValue({
				read: vi.fn().mockReturnValue(mockStream),
			})

			const runPromise = terminalProcess.run("npm run build")
			terminalProcess.emit("stream_available", mockStream)

			expect(terminalProcess.isHot).toBe(true)

			// onDidEndTerminalShellExecution is a separate global VSCode event, not
			// something coupled to the stream iterator being pulled again -- emit it
			// independently of stream consumption, matching real-world timing.
			// Use setTimeout(0) so it fires after microtask-based stream processing
			// has consumed all chunks including the D marker.
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

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
