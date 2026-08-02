import EventEmitter from "events"
import type { TerminalLifecycle } from "./TerminalLifecycle"

export type RooTerminalProvider = "vscode" | "execa"

export interface RooTerminal {
	provider: RooTerminalProvider
	id: number
	reuseKey: string
	busy: boolean
	running: boolean
	taskId?: string
	process?: RooTerminalProcess
	lifecycle?: TerminalLifecycle
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (command: string, callbacks: RooTerminalCallbacks) => RooTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(
		exitDetails: ExitCodeDetails,
		options?: { executionId?: string; acceptNoOwner?: boolean },
	): void
	getProcessesWithOutput(): RooTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
	canReuse?(options: {
		cwd: string
		reuseKey: string
		hasProcess: boolean
		shellIntegrationDefined?: boolean
		hasStaleActiveShellExecution?: boolean
	}): boolean
}

export interface RooTerminalCallbacks {
	onLine: (line: string, process: RooTerminalProcess) => void
	onCompleted: (output: string | undefined, process: RooTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: RooTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: RooTerminalProcess) => void
	onNoShellIntegration?: (details: ShellIntegrationErrorDetails, process: RooTerminalProcess) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed error contract (Sub-task 1, REQ-004)
// ─────────────────────────────────────────────────────────────────────────────

/** Stable machine-readable terminal error codes. */
export type TerminalErrorCode =
	| "SI_ACTIVATION_TIMEOUT"
	| "SI_NEVER_AVAILABLE"
	| "EXEC_START_TIMEOUT"
	| "EXEC_END_TIMEOUT"
	| "OUTPUT_MISSING"
	| "PROVIDER_SWITCH"
	| "TERMINAL_BUSY_STALE"
	| "TERMINAL_DISPOSED"
	| "PROCESS_EXITED_EARLY"
	| "COMMAND_FAILED"

/** Phase where a terminal error occurred. */
export type TerminalErrorPhase = "prepare" | "submit" | "start" | "stream" | "end" | "cleanup" | "provider-switch"

/** Known outcome of a command when the error was raised. */
export type TerminalErrorOutcome = "not-started" | "running" | "completed" | "unknown"

/** Retry policy for an error. */
export type TerminalErrorRetryDisposition = "same-terminal-once" | "fallback-safe" | "never"

export interface TerminalExecutionErrorOptions {
	code: TerminalErrorCode
	message: string
	phase: TerminalErrorPhase
	provider: RooTerminalProvider
	terminalId?: string | number
	commandSubmitted: boolean
	outcome: TerminalErrorOutcome
	retryDisposition: TerminalErrorRetryDisposition
	causeName?: string
}

/**
 * Base class for all terminal execution errors. Carries stable codes and safe
 * metadata. It deliberately does NOT contain command text, CWD, output,
 * environment variables, or shell arguments.
 */
export class TerminalExecutionError extends Error {
	public readonly code: TerminalErrorCode
	public readonly phase: TerminalErrorPhase
	public readonly provider: RooTerminalProvider
	public readonly terminalId: string | number | undefined
	public readonly commandSubmitted: boolean
	public readonly outcome: TerminalErrorOutcome
	public readonly retryDisposition: TerminalErrorRetryDisposition
	public readonly causeName?: string

	constructor(options: TerminalExecutionErrorOptions) {
		super(options.message)
		this.name = "TerminalExecutionError"
		this.code = options.code
		this.phase = options.phase
		this.provider = options.provider
		this.terminalId = options.terminalId
		this.commandSubmitted = options.commandSubmitted
		this.outcome = options.outcome
		this.retryDisposition = options.retryDisposition
		this.causeName = options.causeName
	}
}

export interface ShellIntegrationErrorDetails {
	message: string
	commandSubmitted: boolean
	code?: TerminalErrorCode
	phase?: TerminalErrorPhase
	provider?: RooTerminalProvider
	terminalId?: string | number
	outcome?: TerminalErrorOutcome
	retryDisposition?: TerminalErrorRetryDisposition
	causeName?: string
}

/**
 * Backward-compatible ShellIntegrationError. The original two-argument
 * constructor is preserved, while new typed fields are available via the
 * TerminalExecutionError base.
 */
export class ShellIntegrationError extends TerminalExecutionError {
	constructor(
		message: string,
		commandSubmitted: boolean,
		code: TerminalErrorCode = "SI_ACTIVATION_TIMEOUT",
		options?: Omit<ShellIntegrationErrorDetails, "message" | "commandSubmitted" | "code">,
	) {
		const phase = options?.phase ?? "prepare"
		const provider = options?.provider ?? "vscode"
		const outcome: TerminalErrorOutcome = options?.outcome ?? (commandSubmitted ? "unknown" : "not-started")
		const retryDisposition: TerminalErrorRetryDisposition =
			options?.retryDisposition ?? (commandSubmitted ? "never" : "same-terminal-once")

		super({
			code,
			message,
			phase,
			provider,
			terminalId: options?.terminalId,
			commandSubmitted,
			outcome,
			retryDisposition,
			causeName: options?.causeName,
		})
		this.name = "ShellIntegrationError"
	}

	static fromDetails(details: ShellIntegrationErrorDetails, options?: { causeName?: string }): ShellIntegrationError {
		const code = details.code ?? "SI_ACTIVATION_TIMEOUT"
		const commandSubmitted = details.commandSubmitted
		const defaultOutcome: TerminalErrorOutcome = commandSubmitted ? "unknown" : "not-started"
		const defaultRetry: TerminalErrorRetryDisposition = commandSubmitted ? "never" : "same-terminal-once"

		return new ShellIntegrationError(details.message, commandSubmitted, code, {
			phase: details.phase ?? "prepare",
			provider: details.provider ?? "vscode",
			terminalId: details.terminalId,
			outcome: details.outcome ?? defaultOutcome,
			retryDisposition: details.retryDisposition ?? defaultRetry,
			causeName: options?.causeName ?? details.causeName,
		})
	}
}

export interface RooTerminalProcess extends EventEmitter<RooTerminalProcessEvents> {
	command: string
	executionId?: string
	isHot: boolean
	run: (command: string) => Promise<void>
	continue: () => void
	abort: () => void
	hasUnretrievedOutput: () => boolean
	getUnretrievedOutput: () => string
	trimRetrievedOutput: () => void
}

export type RooTerminalProcessResultPromise = RooTerminalProcess & Promise<void>

export interface RooTerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: [output?: string]
	stream_available: [stream: AsyncIterable<string>]
	shell_execution_started: [pid: number | undefined]
	shell_execution_complete: [exitDetails: ExitCodeDetails]
	error: [error: Error]
	no_shell_integration: [details: ShellIntegrationErrorDetails]
}

export interface ExitCodeDetails {
	exitCode: number | undefined
	signal?: number | undefined
	signalName?: string
	coreDumpPossible?: boolean
}
