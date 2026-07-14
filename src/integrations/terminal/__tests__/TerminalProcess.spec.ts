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

		it("runs command after shell integration activates via onDidChangeTerminalShellIntegration event", async () => {
			// Cover Terminal.runCommand's waitForShellIntegration resolve path: shell
			// integration is initially absent but arrives via the VSCode event before timeout.
			let shellIntegrationHandler: ((e: any) => void) | undefined
			vi.spyOn(vscode.window, "onDidChangeTerminalShellIntegration" as any).mockImplementation((handler: any) => {
				shellIntegrationHandler = handler
				return { dispose: vi.fn() }
			})

			mockTerminal.shellIntegration = undefined
			const runPromise = mockTerminalInfo.runCommand("test command", {
				onLine: vi.fn(),
				onCompleted: vi.fn(),
				onShellExecutionStarted: vi.fn(),
				onShellExecutionComplete: vi.fn(),
			})

			// Fire the shell integration activation event — simulates VSCode telling us the
			// shell is ready. waitForShellIntegration should resolve, then process.run() fires.
			expect(shellIntegrationHandler).toBeDefined()
			mockTerminal.shellIntegration = {
				executeCommand: vi.fn().mockReturnValue({ read: vi.fn().mockReturnValue((async function* () {})()) }),
			}
			shellIntegrationHandler!({ terminal: mockTerminal })

			// Give the .then() callback a chance to run process.run()
			await Promise.resolve()
			await Promise.resolve()

			// process.run() should have been called (shell integration is now present, so
			// run() won't take the !isShellIntegrationAvailable path)
			await Promise.resolve()
			terminalProcess.emit(
				"stream_available",
				(async function* () {
					yield "\x1b]633;C\x07"
					yield "\x1b]633;D\x07"
				})(),
			)
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await runPromise
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

		it("does not drop the final chunk when shellExecutionComplete fires concurrently with the last data chunk", async () => {
			// Regression for the doneSignal.done race: if shell_execution_complete fires
			// while Promise.race is resolving with a real chunk, doneSignal.done flips to
			// true before the continuation resumes. The loop must NOT break on doneSignal.done
			// after a chunk wins — only DONE_SENTINEL triggers the early break.
			let completedOutput: string | undefined
			terminalProcess.once("completed", (output?: string) => {
				completedOutput = output
			})

			const runPromise = terminalProcess.run("echo hello")

			// Emit the stream; the final chunk and shell_execution_complete arrive together.
			terminalProcess.emit(
				"stream_available",
				(async function* () {
					yield "\x1b]633;C\x07"
					yield "hello\n"
					// Emit completion concurrently with the D marker chunk so doneSignal.done
					// is true when Promise.race resolves with the D marker result.
					terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
					yield "\x1b]633;D\x07"
				})(),
			)

			await runPromise

			expect(completedOutput).toBe("hello\n")
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

		it("emits no_shell_integration with commandSubmitted=true when stream never arrives after command submission", async () => {
			vi.useFakeTimers()
			const prevTimeout = Terminal.getShellIntegrationTimeout()
			Terminal.setShellIntegrationTimeout(50)

			try {
				let commandSubmitted: boolean | undefined
				let completedOutput: string | undefined

				const done = Promise.all([
					new Promise<void>((resolve) =>
						terminalProcess.once("no_shell_integration", (details) => {
							commandSubmitted = details.commandSubmitted
							resolve()
						}),
					),
					new Promise<void>((resolve) =>
						terminalProcess.once("completed", (output?: string) => {
							completedOutput = output
							resolve()
						}),
					),
					new Promise<void>((resolve) => terminalProcess.once("continue", resolve)),
				])

				// run() submits the command (shell integration IS present) but stream_available
				// is never emitted, so the streamAvailable timeout fires.
				const runPromise = terminalProcess.run("test command")
				await vi.advanceTimersByTimeAsync(100)
				await runPromise
				await done

				expect(commandSubmitted).toBe(true)
				expect(completedOutput).toContain("stream did not start")
			} finally {
				Terminal.setShellIntegrationTimeout(prevTimeout)
				vi.useRealTimers()
			}
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

		it("resolves waitForShellIntegration immediately when shell integration is already active", async () => {
			// Cover waitForShellIntegration fast path: shellIntegration already present → resolves synchronously.
			// Access the private method via bracket notation so we can call it directly.
			mockTerminal.shellIntegration = { executeCommand: vi.fn() }
			const result = (mockTerminalInfo as any).waitForShellIntegration(5000)
			// Should resolve immediately (synchronously resolved Promise) without touching timers.
			await expect(result).resolves.toBeUndefined()
		})

		it("handles executeCommand throwing by propagating the error", async () => {
			mockTerminal.shellIntegration.executeCommand.mockImplementation(() => {
				throw new Error("execution failed")
			})

			await expect(terminalProcess.run("bad command")).rejects.toThrow("execution failed")
		})

		it("self-finalizes via idle timeout when no stream data arrives and no event fires", async () => {
			vi.useFakeTimers()
			const prevTimeout = Terminal.getShellIntegrationTimeout()
			Terminal.setShellIntegrationTimeout(50)

			try {
				const events: string[] = []
				const done = Promise.all([
					new Promise<void>((resolve) =>
						terminalProcess.once("completed", () => {
							events.push("completed")
							resolve()
						}),
					),
					new Promise<void>((resolve) =>
						terminalProcess.once("continue", () => {
							events.push("continue")
							resolve()
						}),
					),
				])

				// An empty stream that never yields anything and never closes.
				// shellExecutionComplete never fires either — simulates a completely
				// silent command with no events (the idle-timeout self-finalize path).
				const neverEndingStream: AsyncIterable<string> = {
					[Symbol.asyncIterator]() {
						return {
							next(): Promise<IteratorResult<string>> {
								return new Promise(() => {}) // hangs forever
							},
						}
					},
				}

				const runPromise = terminalProcess.run("silent command")
				terminalProcess.emit("stream_available", neverEndingStream)
				// Let the first idle timeout (3s) fire without shellExecutionStarted.
				// That keeps looping. Advance past getShellIntegrationTimeout (50ms) so
				// the "shell init timeout exceeded" branch fires and we fall through to break.
				await vi.advanceTimersByTimeAsync(3100)

				await runPromise
				await done

				expect(events).toContain("completed")
			} finally {
				Terminal.setShellIntegrationTimeout(prevTimeout)
				vi.useRealTimers()
			}
		})

		it("passes a temp-script invocation to executeCommand for multiline POSIX commands when profile shell is set", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue({
				shellPath: "/bin/bash",
				shellArgs: undefined,
			})

			const command = "echo a\necho b"
			const runPromise = terminalProcess.run(command)
			terminalProcess.emit(
				"stream_available",
				(async function* () {
					yield "\x1b]633;C\x07"
					yield "a\n"
					yield "b\n"
					yield "\x1b]633;D\x07"
				})(),
			)
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await runPromise

			// executeCommand should be called with a shell + temp-script invocation, not the
			// raw multiline command string.
			const calledWith = mockTerminal.shellIntegration.executeCommand.mock.calls[0][0] as string
			expect(calledWith).toMatch(/^"\/bin\/bash" ".*roo-cmd-.*\.sh"$/)
		})

		it("uses VS Code default profile shell for temp-script when no Zoo Code profile override is set", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			vi.spyOn(Terminal, "getConfiguredDefaultProfileName").mockReturnValue("bash")
			vi.spyOn(Terminal, "getConfiguredProfiles").mockReturnValue({
				bash: { path: "/bin/bash" },
			})
			// resolveProfilePath calls existsSync, which returns false on Windows for POSIX
			// paths. Mock it so the test is platform-independent.
			vi.spyOn(Terminal, "resolveProfilePath").mockReturnValue("/bin/bash")

			const command = "echo a\necho b"
			const runPromise = terminalProcess.run(command)
			terminalProcess.emit(
				"stream_available",
				(async function* () {
					yield "\x1b]633;C\x07"
					yield "a\n"
					yield "b\n"
					yield "\x1b]633;D\x07"
				})(),
			)
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await runPromise

			const calledWith = mockTerminal.shellIntegration.executeCommand.mock.calls[0][0] as string
			expect(calledWith).toMatch(/^"\/bin\/bash" ".*roo-cmd-.*\.sh"$/)
		})

		it("uses PS dot-source wrapping when the default profile resolves to PowerShell (not a .sh temp-script)", async () => {
			vi.spyOn(Terminal, "getProfileShell").mockReturnValue(undefined)
			vi.spyOn(Terminal, "isActiveShellPowerShell").mockReturnValue(false) // detection missed it
			vi.spyOn(Terminal, "isActiveShellFish").mockReturnValue(false)
			vi.spyOn(Terminal, "getConfiguredDefaultProfileName").mockReturnValue("Windows PowerShell")
			vi.spyOn(Terminal, "getConfiguredProfiles").mockReturnValue({
				"Windows PowerShell": { path: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
			})
			vi.spyOn(Terminal, "resolveProfilePath").mockReturnValue(
				"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			)

			const command = "echo a\necho b"
			const runPromise = terminalProcess.run(command)
			terminalProcess.emit(
				"stream_available",
				(async function* () {
					yield "\x1b]633;C\x07"
					yield "a\n"
					yield "b\n"
					yield "\x1b]633;D\x07"
				})(),
			)
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await runPromise

			const calledWith = mockTerminal.shellIntegration.executeCommand.mock.calls[0][0] as string
			expect(calledWith).toBe(`. {\necho a\necho b\n}`)
		})

		it("completes cleanly when shellExecutionComplete fires before stream_available", async () => {
			const completedOutputs: string[] = []
			terminalProcess.on("completed", (output) => completedOutputs.push(output ?? ""))

			// Emit shell_execution_complete on the next tick — after run() has registered its
			// once("shell_execution_complete") listener but before stream_available fires.
			// This simulates a zero-output command where the end event beats the stream event.
			setTimeout(() => terminalProcess.emit("shell_execution_complete", { exitCode: 0 }), 0)

			await terminalProcess.run("echo hello")

			expect(completedOutputs).toEqual([""])
			expect(terminalProcess.isHot).toBe(false)
			expect(mockTerminalInfo.busy).toBe(false)
			expect(mockTerminalInfo.activeShellExecution).toBeUndefined()
		})

		it("does not leave terminal busy when onDidStartTerminalShellExecution fires after early completion", async () => {
			// Simulate the production race: end event arrives before the stream.
			// The registry's onDidEndTerminalShellExecution handler (running=false branch) calls
			// terminal.shellExecutionComplete(), which clears terminal.process = undefined.
			// A late onDidStartTerminalShellExecution then arrives: setActiveStream() returns
			// early (no process), and TerminalRegistry must not set busy = true afterward.

			// Step 1: end fires before run() sets running=true (the !terminal.running registry branch).
			// Drive this by having the shell_execution_complete event clear terminal.process
			// the same way shellExecutionComplete() does.
			setTimeout(() => mockTerminalInfo.shellExecutionComplete({ exitCode: 0, signal: undefined }), 0)
			await terminalProcess.run("echo hello")

			// terminal.process was cleared by shellExecutionComplete().
			expect(mockTerminalInfo.process).toBeUndefined()
			expect(mockTerminalInfo.busy).toBe(false)

			// Step 2: late start event arrives — setActiveStream returns early (no process).
			// Replicate the TerminalRegistry guard: only set busy when process exists.
			const lateStream = (async function* () {})()
			mockTerminalInfo.setActiveStream(lateStream)
			if (mockTerminalInfo.process) {
				mockTerminalInfo.busy = true
			}

			expect(mockTerminalInfo.busy).toBe(false)
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

		it("trims at OSC 133;D when only a 133 end marker is present (no 633 marker)", () => {
			// Line 598: endIndex = index133 branch — only the 133 end marker exists.
			terminalProcess["fullOutput"] = "hello\x1b]133;D\x07world"
			terminalProcess["lastRetrievedIndex"] = 0

			const unretrieved = terminalProcess.getUnretrievedOutput()
			expect(unretrieved).toBe("hello")
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
