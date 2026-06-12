import { spawnSync } from "child_process"

import { execa, ExecaError } from "execa"
import process from "process"

import type { RooTerminal } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { BaseTerminalProcess } from "./BaseTerminalProcess"

export class ExecaTerminalProcess extends BaseTerminalProcess {
	private terminalRef: WeakRef<RooTerminal>
	private aborted = false
	private pid?: number
	private subprocess?: ReturnType<typeof execa>

	constructor(terminal: RooTerminal) {
		super()

		this.terminalRef = new WeakRef(terminal)

		this.once("completed", () => {
			this.terminal.busy = false
		})
	}

	public get terminal(): RooTerminal {
		const terminal = this.terminalRef.deref()

		if (!terminal) {
			throw new Error("Unable to dereference terminal")
		}

		return terminal
	}

	public override async run(command: string) {
		this.command = command

		try {
			this.isHot = true

			this.subprocess = execa({
				shell: BaseTerminal.getExecaShellPath() || true,
				cwd: this.terminal.getCurrentWorkingDirectory(),
				all: true,
				stdin: "ignore",
				// On POSIX, detached: true puts the child in its own process group so
				// abort() can send SIGKILL to the entire group via process.kill(-pid).
				// On Windows, detached: true causes a console-window flash that
				// windowsHide cannot reliably suppress (the OS allocates the window
				// before the hide flag is fully processed).
				// We omit detached on Windows; Windows abort() uses `taskkill /F /T` instead,
				// which walks the PPID tree via Windows APIs and does not
				// require the child to be in a detached state.
				detached: process.platform !== "win32",
				env: {
					...process.env,
					// Ensure UTF-8 encoding for Ruby, CocoaPods, etc.
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			})`${command}`
	
			this.pid = this.subprocess.pid

			const rawStream = this.subprocess.iterable({ from: "all", preserveNewlines: true })

			// Wrap the stream to ensure all chunks are strings (execa can return Uint8Array)
			const stream = (async function* () {
				for await (const chunk of rawStream) {
					yield typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
				}
			})()

			this.terminal.setActiveStream(stream, this.pid)

			for await (const line of stream) {
				if (this.aborted) {
					break
				}

				this.fullOutput += line

				const now = Date.now()

				if (this.isListening && (now - this.lastEmitTime_ms > 500 || this.lastEmitTime_ms === 0)) {
					this.emitRemainingBufferIfListening()
					this.lastEmitTime_ms = now
				}

				this.startHotTimer(line)
			}

				if (this.aborted) {
					try {
						await this.subprocess
					} catch (error) {
						// Expected: process was killed by abort(); swallow the error.
					}
	
					// 128 + 9 (SIGKILL) mirrors the conventional shell exit code so the
					// UI indicator correctly shows a non-zero (red) exit.
					this.emit("shell_execution_complete", { exitCode: 137, signalName: "SIGKILL" })
				} else {
					this.emit("shell_execution_complete", { exitCode: 0 })
				}
		} catch (error) {
			// If abort() fired and the stream threw before the loop checked this.aborted,
			// treat it as a SIGKILL exit rather than a generic error.
			if (this.aborted) {
				this.emit("shell_execution_complete", { exitCode: 137, signalName: "SIGKILL" })
			} else if (error instanceof ExecaError) {
				console.error(`[ExecaTerminalProcess#run] shell execution error: ${error.message}`)
				this.emit("shell_execution_complete", { exitCode: error.exitCode ?? 0, signalName: error.signal })
			} else {
				console.error(
					`[ExecaTerminalProcess#run] shell execution error: ${error instanceof Error ? error.message : String(error)}`,
				)

				this.emit("shell_execution_complete", { exitCode: 1 })
			}
			this.subprocess = undefined
		}

		this.terminal.setActiveStream(undefined)
		this.emitRemainingBufferIfListening()
		this.stopHotTimer()
		this.emit("completed", this.fullOutput)
		this.emit("continue")
		this.subprocess = undefined
	}

	public override continue() {
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort() {
		this.aborted = true

		if (!this.pid) {
			return
		}

		if (process.platform === "win32") {
			// On Windows, taskkill /F /T kills the entire process tree (shell + all
			// child commands), since negative-PID group kill is a POSIX-only concept.
			try {
				spawnSync("taskkill", ["/F", "/T", "/PID", String(this.pid)])
			} catch (e) {
				console.warn(
					`[ExecaTerminalProcess#abort] taskkill failed for PID ${this.pid}: ${e instanceof Error ? e.message : String(e)}`,
				)

				// Fall back to killing the subprocess directly.
				try {
					this.subprocess?.kill("SIGKILL")
				} catch (e2) {
					console.warn(
						`[ExecaTerminalProcess#abort] Fallback kill also failed: ${e2 instanceof Error ? e2.message : String(e2)}`,
					)
				}
			}
		} else {
			// POSIX: kill the entire process group (shell + all child commands) with
			// SIGKILL. Using a negative PID sends the signal to every process in
			// the group, so child commands are not orphaned. Requires 'detached'.
			try {
				process.kill(-this.pid, "SIGKILL")
			} catch (e) {
				console.warn(
					`[ExecaTerminalProcess#abort] Failed to kill process group -${this.pid}: ${e instanceof Error ? e.message : String(e)}`,
				)

				// Fall back to killing the subprocess directly if process group kill fails.
				try {
					this.subprocess?.kill("SIGKILL")
				} catch (e2) {
					console.warn(
						`[ExecaTerminalProcess#abort] Fallback kill also failed: ${e2 instanceof Error ? e2.message : String(e2)}`,
					)
				}
			}
		}
	}

	public override hasUnretrievedOutput() {
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	public override getUnretrievedOutput() {
		let output = this.fullOutput.slice(this.lastRetrievedIndex)
		let index = output.lastIndexOf("\n")

		if (index === -1) {
			return ""
		}

		index++
		this.lastRetrievedIndex += index

		// console.log(
		// 	`[ExecaTerminalProcess#getUnretrievedOutput] fullOutput.length=${this.fullOutput.length} lastRetrievedIndex=${this.lastRetrievedIndex}`,
		// 	output.slice(0, index),
		// )

		return output.slice(0, index)
	}

	private emitRemainingBufferIfListening() {
		if (!this.isListening) {
			return
		}

		const output = this.getUnretrievedOutput()

		if (output !== "") {
			this.emit("line", output)
		}
	}
}
