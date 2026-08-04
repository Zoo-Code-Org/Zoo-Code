import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import type { ExitCodeDetails } from "./types"
import { BaseTerminalProcess } from "./BaseTerminalProcess"
import { Terminal } from "./Terminal"

export class TerminalProcess extends BaseTerminalProcess {
	// #266: Some processes (interactive tools, programs that trap SIGINT and
	// prompt for confirmation) need more than one Ctrl+C to actually exit. We
	// send Ctrl+C up to this many times in TOTAL — the immediate send in abort()
	// plus retries — checking between sends whether the process has exited, before
	// giving up and letting dispose() proceed.
	private static readonly CTRL_C_SEND_LIMIT = 3
	// Delay between Ctrl+C re-sends. Kept short so cancel stays responsive; the
	// retry window is bounded by (CTRL_C_SEND_LIMIT - 1) * ABORT_RETRY_DELAY_MS.
	private static readonly ABORT_RETRY_DELAY_MS = 500

	private terminalRef: WeakRef<Terminal>
	// Guards against overlapping abort retry loops if abort() is called again
	// while a previous loop is still re-sending Ctrl+C.
	private aborting = false
	// The specific VSCode shell execution this process was started with. Kept on the
	// process (not just terminal.activeShellExecution, which gets reused/reassigned as
	// soon as the next command starts) so TerminalRegistry can tell a late
	// onDidEndTerminalShellExecution event for THIS execution apart from one belonging to
	// whatever command is currently running on the same reused terminal -- see the
	// self-finalize grace period in run()'s finalize().
	public ownExecution?: vscode.TerminalShellExecution

	constructor(terminal: Terminal) {
		super()

		this.terminalRef = new WeakRef(terminal)

		this.once("completed", () => {
			this.terminal.busy = false
		})

		this.once("no_shell_integration", () => {
			this.emit("completed", "<no shell integration>")
			this.terminal.busy = false
			this.terminal.setActiveStream(undefined)
			this.continue()
		})
	}

	public get terminal(): Terminal {
		const terminal = this.terminalRef.deref()

		if (!terminal) {
			throw new Error("Unable to dereference terminal")
		}

		return terminal
	}

	public override async run(command: string) {
		this.command = command

		const terminal = this.terminal.terminal

		const isShellIntegrationAvailable = terminal.shellIntegration && terminal.shellIntegration.executeCommand

		if (!isShellIntegrationAvailable) {
			terminal.sendText(command, true)

			console.warn(
				"[TerminalProcess] Shell integration not available. Command sent without knowledge of response.",
			)

			this.emit("no_shell_integration", {
				message: "Command was submitted; output is not available, as shell integration is inactive.",
				commandSubmitted: true,
			})

			this.emit(
				"completed",
				"<shell integration is not available, so terminal output and command execution status is unknown>",
			)

			this.emit("continue")
			return
		}

		// Create a promise that resolves when the stream becomes available.
		// cancelStreamWait() lets the early-completion race path abort the pending
		// timeout so it doesn't fire (and reject) after we've already returned.
		let cancelStreamWait: () => void = () => {}
		const streamAvailable = new Promise<AsyncIterable<string>>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				// Remove event listener to prevent memory leaks
				this.removeAllListeners("stream_available")

				// Emit no_shell_integration event with descriptive message
				this.emit("no_shell_integration", {
					message: `VSCE shell integration stream did not start within ${Terminal.getShellIntegrationTimeout() / 1000} seconds. Terminal problem?`,
					commandSubmitted: true,
				})

				// Reject with descriptive error
				reject(
					new Error(
						`VSCE shell integration stream did not start within ${Terminal.getShellIntegrationTimeout() / 1000} seconds.`,
					),
				)
			}, Terminal.getShellIntegrationTimeout())

			cancelStreamWait = () => {
				clearTimeout(timeoutId)
				this.removeAllListeners("stream_available")
			}

			// Clean up timeout if stream becomes available
			this.once("stream_available", (stream: AsyncIterable<string>) => {
				clearTimeout(timeoutId)
				resolve(stream)
			})
		})

		// Create promise that resolves when shell execution completes for this terminal.
		// We also expose a "done" sentinel so the stream-reading loop can be interrupted
		// when this event fires while we are blocked awaiting the next chunk — VSCode's
		// AsyncIterable has no built-in cancellation mechanism.
		const doneSignal = { done: false }
		// Resolves to a sentinel object (not ExitCodeDetails) so we can distinguish it
		// from a real chunk in the interruptible loop below.
		const shellExecutionComplete = new Promise<ExitCodeDetails>((resolve) => {
			this.once("shell_execution_complete", (details: ExitCodeDetails) => {
				doneSignal.done = true
				resolve(details)
			})
		})

		// Register shell_execution_started listener BEFORE awaiting streamAvailable.
		// BaseTerminal.setActiveStream emits shell_execution_started and stream_available
		// on the same synchronous tick (in that order). If we register after the await,
		// we miss the event and shellExecutionStarted stays false, causing the idle-timeout
		// guard to incorrectly treat a running-but-silent command as stalled.
		let shellExecutionStarted = false
		this.once("shell_execution_started", () => {
			shellExecutionStarted = true
		})

		// Execute command.
		// Determine whether the active shell is PowerShell so we can apply the
		// PS-specific counter/sleep workarounds.  Prefer the Zoo Code profile
		// override (if set) over the VS Code default profile.  Fix for the wrong
		// config API: must be getConfiguration("terminal.integrated").get(
		// "defaultProfile.windows"), not the reversed form that always returns null.
		const shellKind = {
			isPowerShell: Terminal.isActiveShellPowerShell(),
			isFish: Terminal.isActiveShellFish(),
		}
		let commandToExecute = command

		if (shellKind.isPowerShell) {
			// Only add the PowerShell counter workaround if enabled
			if (Terminal.getPowershellCounter()) {
				commandToExecute += ` ; "(Roo/PS Workaround: ${this.terminal.cmdCounter++})" > $null`
			}

			// Only add the sleep command if the command delay is greater than 0
			if (Terminal.getCommandDelay() > 0) {
				commandToExecute += ` ; start-sleep -milliseconds ${Terminal.getCommandDelay()}`
			}
		}

		try {
			const execution = terminal.shellIntegration.executeCommand(
				this.prepareCommandForShellIntegration(commandToExecute, shellKind),
			)

			this.ownExecution = execution
			this.terminal.activeShellExecution = execution
			// Do NOT call execution.read() here. Reading must happen inside
			// onDidStartTerminalShellExecution (TerminalRegistry), which fires when
			// VSCode's shell integration confirms the command has actually started
			// executing. Calling read() before that event — particularly on a cold
			// terminal where the shell is still initializing — creates a stream window
			// that misses output: the execution begins after the stream was opened,
			// VSCode doesn't buffer retroactively, and zero chunks arrive.
		} catch (error) {
			this.terminal.activeShellExecution = undefined
			this.cleanupScriptFile()
			throw error
		}

		this.isHot = true

		// Wait for stream to be available, but also race against shellExecutionComplete.
		// If the end event fires before the stream arrives (e.g. a zero-output command
		// where onDidEndTerminalShellExecution beats onDidStartTerminalShellExecution),
		// we would otherwise block until the stream timeout fires. Resolving early on
		// completion produces a clean empty-output result instead.
		let stream: AsyncIterable<string>

		try {
			const COMPLETED_BEFORE_STREAM = Symbol("completed_before_stream")
			const result = await Promise.race([
				streamAvailable,
				shellExecutionComplete.then(() => COMPLETED_BEFORE_STREAM as typeof COMPLETED_BEFORE_STREAM),
			])

			if (result === COMPLETED_BEFORE_STREAM) {
				console.info("[Terminal Process] shell execution completed before stream arrived — finishing cleanly")
				cancelStreamWait()
				this.terminal.activeShellExecution = undefined
				this.terminal.busy = false
				this.isHot = false
				this.cleanupScriptFile()
				this.emit("completed", "")
				this.emit("continue")
				return
			}

			stream = result as AsyncIterable<string>
		} catch (error) {
			// Stream timeout or other error occurred
			console.error("[Terminal Process] Stream error:", error.message)

			// Emit completed event with error message
			this.emit(
				"completed",
				"<VSCE shell integration stream did not start: terminal output and command execution status is unknown>",
			)

			this.terminal.busy = false
			this.cleanupScriptFile()

			// Emit continue event to allow execution to proceed
			this.emit("continue")
			return
		}

		/*
		 * Extract clean output from raw accumulated output. FYI:
		 * ]633 is a custom sequence number used by VSCode shell integration:
		 * - OSC 633 ; A ST - Mark prompt start
		 * - OSC 633 ; B ST - Mark prompt end
		 * - OSC 633 ; C ST - Mark pre-execution (start of command output)
		 * - OSC 633 ; D [; <exitcode>] ST - Mark execution finished with optional exit code
		 * - OSC 633 ; E ; <commandline> [; <nonce>] ST - Explicitly set command line with optional nonce
		 */

		// Process stream data.
		//
		// VSCode bug: on some platforms/shells (observed with multi-line commands and
		// certain compound single-line commands), the stream can fail to close on its own
		// and onDidEndTerminalShellExecution can fail to fire, even though the ]633;D end
		// marker IS written into the stream -- the command visibly finished, but the event
		// that would normally tell us so is silently dropped. See:
		// https://github.com/microsoft/vscode/issues/316556,
		// https://github.com/microsoft/vscode/issues/250764,
		// https://github.com/microsoft/vscode/issues/254724.
		//
		// We can safely self-finalize on the D marker text alone: it is real, positive
		// proof the shell finished, independent of whether the stream/event machinery
		// ever confirms it. What we deliberately do NOT do is guess a "gone quiet, must be
		// done" timeout: legitimate long-running-but-silent commands (a cold `tsc --noEmit`
		// on a large project easily runs 20-60s with zero interim output) are
		// indistinguishable from the broken-signal case by elapsed time alone, so any fixed
		// threshold either fires falsely on real work or is too long to help. If neither the
		// marker nor the event ever arrives, this still hangs (the pre-existing behavior) --
		// bounded only by the user's own commandExecutionTimeout / the model's agentTimeout
		// at the tool layer, both already user-understood, opt-in settings.
		let sawEndMarker = false
		let chunkCount = 0
		let streamEndedByEvent = false
		let idleTimedOut = false
		const streamStartedAt = Date.now()

		// VSCode's execution.read() AsyncIterable can stay open indefinitely even after
		// the command finishes — it has no built-in cancellation. We need to be able to
		// break out of the loop when onDidEndTerminalShellExecution fires. We do this by
		// manually driving the iterator and racing each .next() call against shellExecutionComplete.
		const iterator = stream[Symbol.asyncIterator]()
		let streamProcessingError: unknown = undefined

		try {
			// A unique sentinel to distinguish "shellExecutionComplete won the race" from a real chunk.
			const DONE_SENTINEL = Symbol("done")
			// A sentinel for the no-data idle timeout (see below).
			const IDLE_SENTINEL = Symbol("idle")

			// How long to wait for the first chunk before assuming the command finished with
			// no output (VSCode bug: { ... }-wrapped multiline commands often produce zero
			// stream data AND delay onDidEndTerminalShellExecution by 60+ seconds).
			// Only applies before any data arrives (chunkCount === 0).
			const IDLE_TIMEOUT_MS = 3_000

			// Hoist nextChunk outside the loop so that re-arming after an idle timeout
			// reuses the same pending .next() promise instead of issuing a second call
			// while the first is still unresolved (violates the async-iterator protocol
			// and silently drops the first output chunk).
			let nextChunk = iterator.next()
			while (true) {
				const racers: Promise<typeof DONE_SENTINEL | typeof IDLE_SENTINEL | IteratorResult<string>>[] = [
					nextChunk,
					shellExecutionComplete.then(() => DONE_SENTINEL as typeof DONE_SENTINEL),
				]

				// Before any data arrives, add a short idle timeout. Once data starts
				// flowing we trust the stream to close normally (or the D-marker path).
				if (chunkCount === 0) {
					racers.push(
						new Promise<typeof IDLE_SENTINEL>((resolve) =>
							setTimeout(() => resolve(IDLE_SENTINEL as typeof IDLE_SENTINEL), IDLE_TIMEOUT_MS),
						),
					)
				}

				const raceResult = await Promise.race(racers)

				if (raceResult === DONE_SENTINEL) {
					// onDidEndTerminalShellExecution fired — the shell says we're done.
					// Do NOT also check doneSignal.done here: if a real chunk won the race
					// but completion fired concurrently, doneSignal.done is true and the
					// chunk would be dropped before being appended. Break only on the
					// sentinel so data chunks always flow through even when completion races.
					streamEndedByEvent = true
					console.info(
						`[Terminal Process] shell execution complete event broke stream loop after ${chunkCount} chunk(s), +${Date.now() - streamStartedAt}ms`,
					)
					break
				}

				if (raceResult === IDLE_SENTINEL) {
					if (shellExecutionStarted) {
						// The command is confirmed running (shell_execution_started fired). A
						// silent command like `sleep 5` can legitimately produce zero output —
						// elapsed time alone is not proof of completion. Re-arm the idle timer
						// and keep waiting for a real chunk, the D marker, or the end event.
						// Reuse the existing nextChunk promise — do NOT call iterator.next() again.
						console.info(
							`[Terminal Process] idle timeout fired but shell execution is running — re-arming (${chunkCount} chunks so far)`,
						)
						continue
					}

					const elapsedMs = Date.now() - streamStartedAt
					const shellInitTimeout = Terminal.getShellIntegrationTimeout()

					if (elapsedMs < shellInitTimeout) {
						// onDidStartTerminalShellExecution hasn't fired yet — the shell is
						// still initializing. Don't self-finalize; re-arm the idle timer
						// and keep waiting.
						console.info(
							`[Terminal Process] idle timeout fired but shell execution not started yet — waiting for shell init (${elapsedMs}ms elapsed)`,
						)
						continue
					}

					// Shell integration timeout exceeded and onDidStartTerminalShellExecution
					// never fired — something went wrong during shell init. Self-finalize.
					console.info(
						`[Terminal Process] shell execution never started after ${elapsedMs}ms — self-finalizing`,
					)
					idleTimedOut = true
					console.info(
						`[Terminal Process] idle timeout (${IDLE_TIMEOUT_MS}ms) after ${chunkCount} chunk(s) — self-finalizing`,
					)
					break
				}

				const { value: data, done } = raceResult as IteratorResult<string>

				if (done) {
					break
				}

				chunkCount++
				console.info(
					`[Terminal Process] stream chunk #${chunkCount} (+${Date.now() - streamStartedAt}ms, ${data.length} chars)`,
				)

				const match = this.fullOutput === "" ? this.matchAfterVsceStartMarkers(data) : undefined

				if (match !== undefined) {
					this.emit("line", "") // Trigger UI to proceed
				}

				// Accumulate data without filtering.
				// notice to future programmers: do not add escape sequence
				// filtering here: fullOutput cannot change in length (see getUnretrievedOutput),
				// and chunks may not be complete so you cannot rely on detecting or removing escape sequences mid-stream.
				this.fullOutput += match !== undefined ? match : data

				// For non-immediately returning commands we want to show loading spinner
				// right away but this wouldn't happen until it emits a line break, so
				// as soon as we get any output we emit to let webview know to show spinner
				const now = Date.now()

				if (this.isListening && (now - this.lastEmitTime_ms > 100 || this.lastEmitTime_ms === 0)) {
					this.emitRemainingBufferIfListening()
					this.lastEmitTime_ms = now
				}

				this.startHotTimer(data)

				if (this.matchBeforeVsceEndMarkers(this.fullOutput) !== undefined) {
					sawEndMarker = true
					console.info(
						`[Terminal Process] D marker observed in stream after ${chunkCount} chunk(s), +${Date.now() - streamStartedAt}ms`,
					)
					break
				}

				// Advance to the next chunk only after the current one has been fully
				// consumed. Calling iterator.next() here (not at the top of the loop)
				// ensures there is never more than one pending .next() call at a time.
				nextChunk = iterator.next()
			}

			if (!sawEndMarker && !streamEndedByEvent) {
				console.info(
					`[Terminal Process] stream ended without a D marker after ${chunkCount} chunk(s), +${Date.now() - streamStartedAt}ms`,
				)
			}

			// Set streamClosed immediately after stream ends.
			this.terminal.setActiveStream(undefined)

			// Wait for shell execution to complete.
			//
			// Exit paths from the loop above:
			//  1. streamEndedByEvent=true  — onDidEndTerminalShellExecution already fired;
			//                                shellExecutionComplete is resolved, nothing to await.
			//  2. idleTimedOut=true        — No data and no event within idle window; the command
			//                                finished but VSCode won't tell us in time. Skip wait.
			//  3. sawEndMarker=true        — D marker seen in stream; event may or may not have
			//                                fired yet. Give it a 1s grace period to arrive with
			//                                the real exit code before proceeding without one.
			//  4. Neither                  — stream closed naturally (no marker, no event yet);
			//                                wait for shellExecutionComplete directly.
			if (streamEndedByEvent || idleTimedOut) {
				// Already resolved or deliberately skipping — nothing to wait for.
				console.info(
					`[Terminal Process] skipping shellExecutionComplete wait (streamEndedByEvent=${streamEndedByEvent}, idleTimedOut=${idleTimedOut})`,
				)
			} else if (sawEndMarker) {
				let graceTimer: NodeJS.Timeout | undefined
				let graceWon = false
				const grace = new Promise<void>((resolve) => {
					graceTimer = setTimeout(() => {
						graceWon = true
						resolve()
					}, 1_000)
				})

				const waitStartedAt = Date.now()
				await Promise.race([shellExecutionComplete, grace])
				clearTimeout(graceTimer)
				console.info(
					`[Terminal Process] post-marker wait resolved after ${Date.now() - waitStartedAt}ms via ${
						graceWon ? "grace timer (no onDidEndTerminalShellExecution)" : "shellExecutionComplete"
					}`,
				)
			} else {
				const waitStartedAt = Date.now()
				await shellExecutionComplete
				console.info(
					`[Terminal Process] shellExecutionComplete resolved after ${Date.now() - waitStartedAt}ms (stream closed, no D marker)`,
				)
			}

			this.terminal.activeShellExecution = undefined

			this.cleanupScriptFile()

			this.isHot = false

			// Emit any remaining output before completing.
			this.emitRemainingBufferIfListening()

			// fullOutput begins after C marker so we only need to trim off D marker
			// (if D exists, see VSCode bug# 237208):
			const match = this.matchBeforeVsceEndMarkers(this.fullOutput)

			if (match !== undefined) {
				this.fullOutput = match
			}

			// For now we don't want this delaying requests since we don't send
			// diagnostics automatically anymore (previous: "even though the
			// command is finished, we still want to consider it 'hot' in case
			// so that api request stalls to let diagnostics catch up").
			this.stopHotTimer()
			this.emit("completed", this.stripCursorSequences(this.removeVSCodeShellIntegration(this.fullOutput)))
			this.emit("continue")
		} catch (error) {
			streamProcessingError = error
			console.error("[Terminal Process] Error during stream processing:", error)
		} finally {
			// Always release the iterator so the underlying VSCode stream can free its
			// resources. (for-await-of does this automatically; our manual .next() loop
			// does not, so we must call .return() explicitly on exit.)
			try {
				await iterator.return?.()
			} catch {
				/* ignore */
			}

			if (streamProcessingError !== undefined) {
				// Ensure cleanup and caller unblocking happen even when the loop throws.
				this.terminal.activeShellExecution = undefined
				this.terminal.busy = false
				this.isHot = false
				this.cleanupScriptFile()
				this.emit(
					"completed",
					`<terminal process error: ${streamProcessingError instanceof Error ? streamProcessingError.message : String(streamProcessingError)}>`,
				)
				this.emit("continue")
			}
		}
	}

	/**
	 * Prepares a multiline command for VSCode shell integration execution.
	 *
	 * For POSIX shells (bash/zsh/sh), wrapping in `{ ... }` triggers a VSCode bug
	 * where the shell integration stream is marked ended before read() is called,
	 * delivering zero chunks even though output is visible in the terminal. The
	 * root cause is that VSCode's multiline compound-command tracking calls
	 * endExecution() on the outer block before our read() arrives, so the async
	 * iterable returns yl.EMPTY immediately.
	 *
	 * Workaround: write the script to a temp file and run it via the shell
	 * executable. This produces a single-line executeCommand() call with no
	 * newlines, so VSCode never enters the multiline code path.
	 *
	 * PowerShell uses `. { ... }` and Fish uses `begin...end` — both have their
	 * own VSCode shell integration handling and are not affected by this bug.
	 *
	 * Returns the command to pass to executeCommand(), and sets this.scriptPath
	 * if a temp file was created (so run() can clean it up after the stream ends).
	 */
	private prepareCommandForShellIntegration(
		command: string,
		shellKind: { isPowerShell: boolean; isFish: boolean },
	): string {
		if (!command.includes("\n")) {
			return command
		}

		if (shellKind.isPowerShell) {
			return `. {\n${command}\n}`
		}

		if (shellKind.isFish) {
			return `begin\n${command}\nend`
		}

		// POSIX shell: write to a temp script file to avoid the VSCode multiline bug.
		// We need a known shell executable to run it — if we can't determine one,
		// fall back to { ... } wrapping (accepts the VSCode zero-chunk bug as a
		// lesser evil than invoking a non-existent "sh" on Windows).
		//
		// Try the Zoo Code profile first; if unset, fall back to the VS Code default
		// profile so users who haven't configured a Zoo Code profile override still
		// get the temp-file path instead of { ... } wrapping.
		let shellExe = Terminal.getProfileShell()?.shellPath
		if (!shellExe) {
			const defaultProfileName = Terminal.getConfiguredDefaultProfileName()
			if (defaultProfileName) {
				const profiles = Terminal.getConfiguredProfiles()
				const profile = profiles?.[defaultProfileName] as { path?: string | string[] } | null | undefined
				if (profile) {
					shellExe = Terminal.resolveProfilePath(profile.path)
				}
			}
		}
		if (!shellExe) {
			return `{\n${command}\n}`
		}

		// If the resolved shell is PowerShell or fish, the branches above should have
		// caught it — but if shell-kind detection missed it (e.g. no explicit default
		// profile configured), fall back to the appropriate wrapper rather than passing
		// a .sh script to a shell that cannot execute it.
		if (Terminal.isPowerShell(shellExe)) {
			return `. {\n${command}\n}`
		}
		if (Terminal.isFish(shellExe)) {
			return `begin\n${command}\nend`
		}

		const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-cmd-"))
		this.scriptDir = scriptDir
		const scriptPath = path.join(scriptDir, "cmd.sh")
		fs.writeFileSync(scriptPath, command, { mode: 0o700 })
		this.scriptPath = scriptPath

		// Quote both paths with double-quotes to handle spaces (e.g. Git Bash on
		// Windows: "C:\Program Files\Git\bin\bash.exe" "C:\Users\...\roo-cmd-*.sh").
		return `"${shellExe}" "${scriptPath}"`
	}

	private scriptPath: string | undefined
	private scriptDir: string | undefined

	private cleanupScriptFile() {
		if (this.scriptPath) {
			try {
				fs.unlinkSync(this.scriptPath)
			} catch {
				// Best-effort: if it's already gone, that's fine.
			}
			this.scriptPath = undefined
		}
		if (this.scriptDir) {
			try {
				fs.rmdirSync(this.scriptDir)
			} catch {
				// Best-effort: ignore if already removed or non-empty.
			}
			this.scriptDir = undefined
		}
	}

	public override continue() {
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort() {
		if (!this.isListening) {
			return
		}

		// Send SIGINT using CTRL+C.
		this.terminal.terminal.sendText("\x03")

		// #266: A single Ctrl+C isn't always enough — some processes trap SIGINT
		// and keep running. Kick off a bounded retry that re-sends Ctrl+C a few
		// times, verifying between attempts whether the process actually exited
		// (terminal.busy flips to false on completion). This is intentionally
		// fire-and-forget so it never blocks the synchronous cancel path; the
		// total retry window is bounded so dispose() is never delayed for long.
		if (!this.aborting) {
			this.aborting = true
			void this.retryAbort()
				.finally(() => {
					this.aborting = false
				})
				.catch((err) => console.error("[TerminalProcess] retryAbort error:", err))
		}
	}

	/**
	 * Re-sends Ctrl+C after the immediate send in abort(), up to CTRL_C_SEND_LIMIT
	 * total sends, waiting ABORT_RETRY_DELAY_MS between sends and stopping early once
	 * the process exits (or once we stop listening). Bounded so it can never loop
	 * indefinitely.
	 */
	private async retryAbort(): Promise<void> {
		// abort() already sent Ctrl+C once, so `sent` starts at 1; re-send until we
		// reach CTRL_C_SEND_LIMIT total.
		for (let sent = 1; sent < TerminalProcess.CTRL_C_SEND_LIMIT; sent++) {
			await new Promise((resolve) => setTimeout(resolve, TerminalProcess.ABORT_RETRY_DELAY_MS))

			// Stop as soon as there's nothing left to interrupt. `isListening` (cleared
			// by continue()) and `terminal.busy` (cleared by shellExecutionComplete() /
			// the "completed" event) are set on different code paths and can diverge, so
			// either one being false is a sufficient stop signal — we deliberately check
			// both rather than collapsing them into one.
			if (!this.isListening) {
				return
			}

			const terminal = this.terminalRef.deref()

			// Stop if the terminal is gone, idle, or has already moved on to a different
			// command. If the original command exits and the terminal is reused before this
			// tick fires, `terminal.busy` can be true for the NEW command while
			// `terminal.process` points at a different TerminalProcess — re-sending Ctrl+C
			// then would interrupt an unrelated command, so we bail out.
			if (!terminal || !terminal.busy || terminal.process !== this) {
				return
			}

			terminal.terminal.sendText("\x03")
		}
	}

	public override hasUnretrievedOutput(): boolean {
		// If the process is still active or has unretrieved content, return true
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	public override getUnretrievedOutput(): string {
		// Get raw unretrieved output
		let outputToProcess = this.fullOutput.slice(this.lastRetrievedIndex)

		// Check for VSCE command end markers
		const index633 = outputToProcess.indexOf("\x1b]633;D")
		const index133 = outputToProcess.indexOf("\x1b]133;D")
		let endIndex = -1

		if (index633 !== -1 && index133 !== -1) {
			endIndex = Math.min(index633, index133)
		} else if (index633 !== -1) {
			endIndex = index633
		} else if (index133 !== -1) {
			endIndex = index133
		}

		// If no end markers were found yet (possibly due to VSCode bug#237208):
		//   For active streams: return only complete lines (up to last \n).
		//   For closed streams: return all remaining content.
		if (endIndex === -1) {
			if (!this.terminal.isStreamClosed) {
				// Stream still running - only process complete lines
				endIndex = outputToProcess.lastIndexOf("\n")

				if (endIndex === -1) {
					// No complete lines
					return ""
				}

				// Include carriage return
				endIndex++
			} else {
				// Stream closed - process all remaining output
				endIndex = outputToProcess.length
			}
		}

		// Update index and slice output
		this.lastRetrievedIndex += endIndex
		outputToProcess = outputToProcess.slice(0, endIndex)

		// Clean and return output
		return this.stripCursorSequences(this.removeVSCodeShellIntegration(outputToProcess))
	}

	private emitRemainingBufferIfListening() {
		if (this.isListening) {
			const remainingBuffer = this.getUnretrievedOutput()

			if (remainingBuffer !== "") {
				this.emit("line", remainingBuffer)
			}
		}
	}

	private stringIndexMatch(
		data: string,
		prefix?: string,
		suffix?: string,
		bell: string = "\x07",
	): string | undefined {
		let startIndex: number
		let endIndex: number
		let prefixLength: number

		if (prefix === undefined) {
			startIndex = 0
			prefixLength = 0
		} else {
			startIndex = data.indexOf(prefix)

			if (startIndex === -1) {
				return undefined
			}

			if (bell.length > 0) {
				// Find the bell character after the prefix
				const bellIndex = data.indexOf(bell, startIndex + prefix.length)

				if (bellIndex === -1) {
					return undefined
				}

				const distanceToBell = bellIndex - startIndex
				prefixLength = distanceToBell + bell.length
			} else {
				prefixLength = prefix.length
			}
		}

		const contentStart = startIndex + prefixLength

		if (suffix === undefined) {
			// When suffix is undefined, match to end
			endIndex = data.length
		} else {
			endIndex = data.indexOf(suffix, contentStart)

			if (endIndex === -1) {
				return undefined
			}
		}

		return data.slice(contentStart, endIndex)
	}

	/**
	 * Remove only VSCode shell integration sequences (OSC 633/133) while
	 * preserving standard ANSI SGR escape codes for color/formatting.
	 *
	 * VSCode shell integration uses OSC 633 and OSC 133 sequences to mark
	 * prompt boundaries, command starts/ends, etc. These are not useful
	 * for inline display and should be stripped.
	 *
	 * Standard ANSI SGR sequences (e.g., \x1B[32m for green) are preserved
	 * so the frontend can render them as styled HTML.
	 */
	private removeVSCodeShellIntegration(text: string): string {
		// Remove OSC 633 sequences: \x1B]633;....\x07 or \x1B]633;....\x1B\\
		// Remove OSC 133 sequences: \x1B]133;....\x07 or \x1B]133;....\x1B\\
		return (
			text
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\]633;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\]133;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\][0-9]+;[^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
		) // Also remove other common OSC sequences that aren't color-related
	}

	private stripCursorSequences(text: string): string {
		return (
			text
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\[\d*[ABCDEFGHJ]/g, "") // Remove cursor movement: up, down, forward, back
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\[su/g, "") // Remove cursor position save/restore
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\[\d*[KJ]/g, "") // Remove erase in line/display
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\[\?25[hl]/g, "") // Remove cursor show/hide
				// eslint-disable-next-line no-control-regex
				.replace(/\x1B\[\d*;\d*r/g, "") // Remove scroll region
		)
	}

	/**
	 * Helper function to match VSCode shell integration start markers (C).
	 * Looks for content after ]633;C or ]133;C markers.
	 * If both exist, takes the content after the last marker found.
	 */
	private matchAfterVsceStartMarkers(data: string): string | undefined {
		return this.matchVsceMarkers(data, "\x1b]633;C", "\x1b]133;C", undefined, undefined)
	}

	/**
	 * Helper function to match VSCode shell integration end markers (D).
	 * Looks for content before ]633;D or ]133;D markers.
	 * If both exist, takes the content before the first marker found.
	 */
	private matchBeforeVsceEndMarkers(data: string): string | undefined {
		return this.matchVsceMarkers(data, undefined, undefined, "\x1b]633;D", "\x1b]133;D")
	}

	/**
	 * Handles VSCode shell integration markers for command output:
	 *
	 * For C (Command Start):
	 * - Looks for content after ]633;C or ]133;C markers
	 * - These markers indicate the start of command output
	 * - If both exist, takes the content after the last marker found
	 * - This ensures we get the actual command output after any shell integration prefixes
	 *
	 * For D (Command End):
	 * - Looks for content before ]633;D or ]133;D markers
	 * - These markers indicate command completion
	 * - If both exist, takes the content before the first marker found
	 * - This ensures we don't include shell integration suffixes in the output
	 *
	 * In both cases, checks 633 first since it's more commonly used in VSCode shell integration
	 *
	 * @param data The string to search for markers in
	 * @param prefix633 The 633 marker to match after (for C markers)
	 * @param prefix133 The 133 marker to match after (for C markers)
	 * @param suffix633 The 633 marker to match before (for D markers)
	 * @param suffix133 The 133 marker to match before (for D markers)
	 * @returns The content between/after markers, or undefined if no markers found
	 *
	 * Note: Always makes exactly 2 calls to stringIndexMatch regardless of match results.
	 * Using string indexOf matching is ~500x faster than regular expressions, so even
	 * matching twice is still very efficient comparatively.
	 */
	private matchVsceMarkers(
		data: string,
		prefix633: string | undefined,
		prefix133: string | undefined,
		suffix633: string | undefined,
		suffix133: string | undefined,
	): string | undefined {
		// Support both VSCode shell integration markers (633 and 133)
		// Check 633 first since it's more commonly used in VSCode shell integration
		let match133: string | undefined
		const match633 = this.stringIndexMatch(data, prefix633, suffix633)

		// Must check explicitly for undefined because stringIndexMatch can return empty strings
		// that are valid matches (e.g., when a marker exists but has no content between markers)
		if (match633 !== undefined) {
			match133 = this.stringIndexMatch(match633, prefix133, suffix133)
		} else {
			match133 = this.stringIndexMatch(data, prefix133, suffix133)
		}

		return match133 !== undefined ? match133 : match633
	}
}
