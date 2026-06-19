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

		// Create a promise that resolves when the stream becomes available
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

			// Clean up timeout if stream becomes available
			this.once("stream_available", (stream: AsyncIterable<string>) => {
				clearTimeout(timeoutId)
				resolve(stream)
			})
		})

		// Create promise that resolves when shell execution completes for this terminal
		const shellExecutionComplete = new Promise<ExitCodeDetails>((resolve) => {
			this.once("shell_execution_complete", (details: ExitCodeDetails) => resolve(details))
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

			this.terminal.activeShellExecution = execution

			// VS Code only captures data written after read() is first called, so read
			// the execution stream immediately instead of waiting for the global start
			// event to deliver the same execution later.
			this.terminal.setActiveStream(execution.read())
		} catch (error) {
			this.terminal.activeShellExecution = undefined
			throw error
		}

		this.isHot = true

		// Wait for stream to be available
		let stream: AsyncIterable<string>

		try {
			stream = await streamAvailable
		} catch (error) {
			// Stream timeout or other error occurred
			console.error("[Terminal Process] Stream error:", error.message)

			// Emit completed event with error message
			this.emit(
				"completed",
				"<VSCE shell integration stream did not start: terminal output and command execution status is unknown>",
			)

			this.terminal.busy = false

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

		// Process stream data
		for await (let data of stream) {
			const match = this.fullOutput === "" ? this.matchAfterVsceStartMarkers(data) : undefined

			if (match !== undefined) {
				data = match
				this.emit("line", "") // Trigger UI to proceed
			}

			// Accumulate data without filtering.
			// notice to future programmers: do not add escape sequence
			// filtering here: fullOutput cannot change in length (see getUnretrievedOutput),
			// and chunks may not be complete so you cannot rely on detecting or removing escape sequences mid-stream.
			this.fullOutput += data

			// For non-immediately returning commands we want to show loading spinner
			// right away but this wouldn't happen until it emits a line break, so
			// as soon as we get any output we emit to let webview know to show spinner
			const now = Date.now()

			if (this.isListening && (now - this.lastEmitTime_ms > 100 || this.lastEmitTime_ms === 0)) {
				this.emitRemainingBufferIfListening()
				this.lastEmitTime_ms = now
			}

			this.startHotTimer(data)
		}

		// Set streamClosed immediately after stream ends.
		this.terminal.setActiveStream(undefined)

		// Wait for shell execution to complete.
		await shellExecutionComplete
		this.terminal.activeShellExecution = undefined

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
	}

	/**
	 * VS Code reports each complete top-level statement in multiline input as a
	 * separate shell execution. Keep the submitted script in one execution so a
	 * leading assignment cannot complete and detach the tracked process before
	 * the remaining statements run.
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

		return `{\n${command}\n}`
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
