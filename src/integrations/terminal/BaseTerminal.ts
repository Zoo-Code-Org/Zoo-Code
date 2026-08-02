import { truncateOutput, applyRunLengthEncoding } from "../misc/extract-text"

import type {
	RooTerminalProvider,
	RooTerminal,
	RooTerminalCallbacks,
	RooTerminalProcess,
	RooTerminalProcessResultPromise,
	ExitCodeDetails,
} from "./types"
import { TerminalLifecycle, type TerminalReuseExternalChecks } from "./TerminalLifecycle"

export abstract class BaseTerminal implements RooTerminal {
	public readonly provider: RooTerminalProvider
	public readonly id: number
	public readonly initialCwd: string
	public readonly reuseKey: string

	/**
	 * Authoritative lifecycle state. The legacy `busy` and `running` flags are
	 * derived from this state for backward compatibility.
	 */
	public readonly lifecycle: TerminalLifecycle

	public taskId?: string
	public process?: RooTerminalProcess
	public completedProcesses: RooTerminalProcess[] = []

	protected streamClosed: boolean

	constructor(provider: RooTerminalProvider, id: number, cwd: string, reuseKey: string = provider) {
		this.provider = provider
		this.id = id
		this.initialCwd = cwd
		this.reuseKey = reuseKey
		this.lifecycle = new TerminalLifecycle(provider)
		this.streamClosed = false
	}

	/** @deprecated Use {@link lifecycle} state instead. */
	public get busy(): boolean {
		return this.lifecycle.busy
	}

	/** @deprecated Use {@link lifecycle} state instead. */
	public set busy(value: boolean) {
		// The lifecycle state machine is the source of truth. This legacy setter
		// is preserved for compatibility but must not manipulate the lifecycle
		// state directly: setting busy=true without an owner could create an
		// ownerless, non-idle terminal that the watchdog cannot reap and that
		// canReuse rejects, permanently stranding it.
		if (value) {
			if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
				console.warn(
					`[BaseTerminal ${this.provider}/${this.id}] busy=true is deprecated and ignored; use the lifecycle API instead.`,
				)
			}
		} else {
			this.lifecycle.resetToIdle()
		}
	}

	/** @deprecated Use {@link lifecycle} state instead. */
	public get running(): boolean {
		return this.lifecycle.running
	}

	/** @deprecated Use {@link lifecycle} state instead. */
	public set running(value: boolean) {
		if (value) {
			this.lifecycle.forceState("running")
		} else if (this.lifecycle.state === "running") {
			this.lifecycle.resetToIdle()
		}
	}

	public getCurrentWorkingDirectory(): string {
		return this.initialCwd
	}

	abstract isClosed(): boolean

	abstract runCommand(command: string, callbacks: RooTerminalCallbacks): RooTerminalProcessResultPromise

	/**
	 * Provider-specific reuse check. Implementers must supply the external
	 * conditions (isClosed, hasProcess, etc.) and delegate to the lifecycle.
	 */
	abstract canReuse(options: {
		cwd: string
		reuseKey: string
		hasProcess: boolean
		shellIntegrationDefined?: boolean
		hasStaleActiveShellExecution?: boolean
	}): boolean

	/**
	 * Sets the active stream for this terminal and notifies the process
	 * @param stream The stream to set, or undefined to clean up
	 * If no process exists when a stream is provided, logs a warning and returns.
	 */
	public setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void {
		if (stream) {
			if (!this.process) {
				this.running = false

				console.warn(
					`[Terminal ${this.provider}/${this.id}] process is undefined, so cannot set terminal stream (probably user-initiated non-Roo command)`,
				)

				return
			}

			// Idempotent transition: only transition if not already in "running" state.
			// This prevents IllegalTransitionError when setActiveStream is called multiple
			// times (e.g., by both TerminalProcess.run and the startTerminalShellExecution
			// event handler).
			if (this.lifecycle.state !== "running") {
				this.lifecycle.transition("running")
			}
			this.streamClosed = false
			this.process.emit("shell_execution_started", pid)
			this.process.emit("stream_available", stream)
		} else {
			this.streamClosed = true
		}
	}

	/**
	 * Handles shell execution completion for this terminal.
	 * @param exitDetails The exit details of the shell execution
	 */
	public shellExecutionComplete(
		exitDetails: ExitCodeDetails,
		options?: { executionId?: string; acceptNoOwner?: boolean },
	) {
		// Guard against a stale end event for a superseded execution. If an
		// execution ID is provided, only reset the terminal when the current
		// owner matches (or the terminal is unowned and acceptNoOwner is true).
		// This prevents a late event from a previous command from wiping the
		// state of a newly acquired owner mid-command.
		const owner = this.lifecycle.ownerExecutionId
		if (options?.executionId && owner !== undefined && owner !== options.executionId) {
			console.info(
				`[BaseTerminal ${this.provider}/${this.id}] shellExecutionComplete ignored: owned by ${owner}, event was for ${options.executionId}`,
			)
			return
		}
		if (options?.executionId && owner === undefined && !options.acceptNoOwner) {
			console.info(
				`[BaseTerminal ${this.provider}/${this.id}] shellExecutionComplete ignored: terminal is unowned`,
			)
			return
		}

		this.lifecycle.resetToIdle()

		if (this.process) {
			// Add to the front of the queue (most recent first).
			if (this.process.hasUnretrievedOutput()) {
				this.completedProcesses.unshift(this.process)
			}

			this.process.emit("shell_execution_complete", exitDetails)
			this.process = undefined
		}
	}

	public get isStreamClosed(): boolean {
		return this.streamClosed
	}

	/**
	 * Gets the last executed command
	 * @returns The last command string or empty string if none
	 */
	public getLastCommand(): string {
		// Return the command from the active process or the most recent process in the queue
		if (this.process) {
			return this.process.command || ""
		} else if (this.completedProcesses.length > 0) {
			return this.completedProcesses[0].command || ""
		}

		return ""
	}

	/**
	 * Cleans the process queue by removing processes that no longer have unretrieved output
	 * or don't belong to the current task
	 */
	public cleanCompletedProcessQueue(): void {
		// Trim retrieved output from each process to free memory, then keep only those with remaining output
		this.completedProcesses = this.completedProcesses.filter((process) => {
			process.trimRetrievedOutput()
			return process.hasUnretrievedOutput()
		})
	}

	/**
	 * Gets all processes with unretrieved output
	 * @returns Array of processes with unretrieved output
	 */
	public getProcessesWithOutput(): RooTerminalProcess[] {
		// Clean the queue first to remove any processes without output
		this.cleanCompletedProcessQueue()
		return [...this.completedProcesses]
	}

	/**
	 * Gets all unretrieved output from both active and completed processes
	 * @returns Combined unretrieved output from all processes
	 */
	public getUnretrievedOutput(): string {
		let output = ""

		// First check completed processes to maintain chronological order
		for (const process of this.completedProcesses) {
			const processOutput = process.getUnretrievedOutput()

			if (processOutput) {
				output += processOutput
			}
		}

		// Then check active process for most recent output
		const activeOutput = this.process?.getUnretrievedOutput()

		if (activeOutput) {
			output += activeOutput
		}

		this.cleanCompletedProcessQueue()
		return output
	}

	public static defaultShellIntegrationTimeout = 5_000
	private static shellIntegrationTimeout: number = BaseTerminal.defaultShellIntegrationTimeout
	private static shellIntegrationDisabled: boolean = false
	private static commandDelay: number = 0
	private static powershellCounter: boolean = false
	private static terminalZshClearEolMark: boolean = true
	private static terminalZshOhMy: boolean = false
	private static terminalZshP10k: boolean = false
	private static terminalZdotdir: boolean = false
	private static terminalProfile: string | undefined = undefined
	private static execaShellPath: string | undefined = undefined

	/**
	 * Compresses terminal output by applying run-length encoding and truncating to line limit
	 * @param input The terminal output to compress
	 * @returns The compressed terminal output
	 */
	public static setShellIntegrationTimeout(timeoutMs: number): void {
		BaseTerminal.shellIntegrationTimeout = timeoutMs
	}

	public static getShellIntegrationTimeout(): number {
		return BaseTerminal.shellIntegrationTimeout
	}

	public static setShellIntegrationDisabled(disabled: boolean): void {
		BaseTerminal.shellIntegrationDisabled = disabled
	}

	public static getShellIntegrationDisabled(): boolean {
		return BaseTerminal.shellIntegrationDisabled
	}

	/**
	 * Sets the command delay in milliseconds
	 * @param delayMs The delay in milliseconds
	 */
	public static setCommandDelay(delayMs: number): void {
		BaseTerminal.commandDelay = delayMs
	}

	/**
	 * Gets the command delay in milliseconds
	 * @returns The command delay in milliseconds
	 */
	public static getCommandDelay(): number {
		return BaseTerminal.commandDelay
	}

	/**
	 * Sets whether to use the PowerShell counter workaround
	 * @param enabled Whether to enable the PowerShell counter workaround
	 */
	public static setPowershellCounter(enabled: boolean): void {
		BaseTerminal.powershellCounter = enabled
	}

	/**
	 * Gets whether to use the PowerShell counter workaround
	 * @returns Whether the PowerShell counter workaround is enabled
	 */
	public static getPowershellCounter(): boolean {
		return BaseTerminal.powershellCounter
	}

	/**
	 * Sets whether to clear the ZSH EOL mark
	 * @param enabled Whether to clear the ZSH EOL mark
	 */
	public static setTerminalZshClearEolMark(enabled: boolean): void {
		BaseTerminal.terminalZshClearEolMark = enabled
	}

	/**
	 * Gets whether to clear the ZSH EOL mark
	 * @returns Whether the ZSH EOL mark clearing is enabled
	 */
	public static getTerminalZshClearEolMark(): boolean {
		return BaseTerminal.terminalZshClearEolMark
	}

	/**
	 * Sets whether to enable Oh My Zsh shell integration
	 * @param enabled Whether to enable Oh My Zsh shell integration
	 */
	public static setTerminalZshOhMy(enabled: boolean): void {
		BaseTerminal.terminalZshOhMy = enabled
	}

	/**
	 * Gets whether Oh My Zsh shell integration is enabled
	 * @returns Whether Oh My Zsh shell integration is enabled
	 */
	public static getTerminalZshOhMy(): boolean {
		return BaseTerminal.terminalZshOhMy
	}

	/**
	 * Sets whether to enable Powerlevel10k shell integration
	 * @param enabled Whether to enable Powerlevel10k shell integration
	 */
	public static setTerminalZshP10k(enabled: boolean): void {
		BaseTerminal.terminalZshP10k = enabled
	}

	/**
	 * Gets whether Powerlevel10k shell integration is enabled
	 * @returns Whether Powerlevel10k shell integration is enabled
	 */
	public static getTerminalZshP10k(): boolean {
		return BaseTerminal.terminalZshP10k
	}

	/**
	 * Compresses terminal output by applying run-length encoding and truncating to reasonable limits.
	 * Uses hardcoded defaults: 500 lines, 50K characters - these are UI display limits to prevent
	 * memory issues, not LLM context limits (which are controlled by terminalOutputPreviewSize).
	 * @param input The terminal output to compress
	 * @returns The compressed terminal output
	 */
	public static compressTerminalOutput(input: string): string {
		// Hardcoded UI display limits - these prevent unbounded memory growth
		// in the chat display, separate from the LLM context limits
		const LINE_LIMIT = 500
		const CHARACTER_LIMIT = 50_000

		return truncateOutput(applyRunLengthEncoding(input), LINE_LIMIT, CHARACTER_LIMIT)
	}

	/**
	 * Sets whether to enable ZDOTDIR handling for zsh
	 * @param enabled Whether to enable ZDOTDIR handling
	 */
	public static setTerminalZdotdir(enabled: boolean): void {
		BaseTerminal.terminalZdotdir = enabled
	}

	/**
	 * Gets whether ZDOTDIR handling is enabled
	 * @returns Whether ZDOTDIR handling is enabled
	 */
	public static getTerminalZdotdir(): boolean {
		return BaseTerminal.terminalZdotdir
	}

	/**
	 * Sets the name of the VS Code terminal profile to use for the integrated
	 * terminal. An empty/undefined value falls back to VS Code's default terminal
	 * behavior.
	 * @param profile The terminal profile name, or undefined for the default
	 */
	public static setTerminalProfile(profile: string | undefined): void {
		const normalized = profile?.trim()
		BaseTerminal.terminalProfile = normalized && normalized.length > 0 ? normalized : undefined
	}

	/**
	 * Gets the name of the VS Code terminal profile to use for the integrated terminal.
	 * @returns The terminal profile name, or undefined when the default should be used
	 */
	public static getTerminalProfile(): string | undefined {
		return BaseTerminal.terminalProfile
	}

	/**
	 * @deprecated Use {@link ShellInvocationAdapter} and
	 * {@link CommandEnvironmentService} instead. This method is retained
	 * for backward compatibility with the CLI host and legacy settings
	 * hydration. New code must not call this method.
	 *
	 * Sets the shell path used by the legacy `shell: true` Execa fallback.
	 * @param shellPath The shell executable path, or undefined for default
	 */
	public static setExecaShellPath(shellPath: string | undefined): void {
		BaseTerminal.execaShellPath = shellPath
	}

	/**
	 * @deprecated Use {@link ShellInvocationAdapter} and
	 * {@link CommandEnvironmentService} instead. This method is retained
	 * for backward compatibility. New code must not call this method.
	 *
	 * Gets the shell path used by the legacy `shell: true` Execa fallback.
	 * @returns The shell executable path, or undefined when not set
	 */
	public static getExecaShellPath(): string | undefined {
		return BaseTerminal.execaShellPath
	}
}

/** Reusable external-check builder used by both provider subclasses. */
export function buildReuseExternalChecks(
	terminal: BaseTerminal,
	options: {
		cwd: string
		reuseKey: string
		hasProcess: boolean
		isClosed: boolean
		shellIntegrationDefined?: boolean
		hasStaleActiveShellExecution?: boolean
	},
): TerminalReuseExternalChecks & { cwdMatches: boolean; reuseKeyMatches: boolean } {
	return {
		isClosed: options.isClosed,
		hasProcess: options.hasProcess,
		reuseKeyMatches: options.reuseKey === terminal.reuseKey,
		cwdMatches: terminal.getCurrentWorkingDirectory() === options.cwd,
		shellIntegrationDefined: options.shellIntegrationDefined,
		hasStaleActiveShellExecution: options.hasStaleActiveShellExecution,
	}
}
