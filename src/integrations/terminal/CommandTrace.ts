/**
 * CommandTrace — observability-only telemetry for terminal command execution.
 *
 * This module provides a safe, append-only trace builder that records timing and
 * status metadata for each command executed through a terminal. It deliberately
 * excludes command text, CWD, output, environment variables, executable arguments,
 * and API credentials.
 *
 * Traces are emitted once at completion via a callback or the global collector.
 * They do not affect control flow; missing fields are undefined rather than errors.
 */

import type { RooTerminalProvider } from "./types"

/**
 * Immutable snapshot of a command execution trace.
 *
 * Safe fields only — no command text, CWD, output, env vars, executable args, or
 * credentials are included. All timing fields are Unix timestamps in milliseconds.
 */
export interface CommandTrace {
	/** Unique identifier for this execution attempt. */
	executionId: string
	/** The task that owns this command. */
	taskId: string
	/** The model ID that generated the tool call, if known. */
	modelId?: string

	// Timing
	/** Timestamp when the LLM tool call was generated and received. */
	toolCallGeneratedAt: number
	/** Timestamp when the command entered the global scheduler queue. */
	queueEnteredAt: number
	/** Timestamp when the command left the queue and acquired the scheduler lease. */
	queueReleasedAt: number
	/** Timestamp when the tool requested a terminal from the registry. */
	terminalRequestedAt: number
	/** Timestamp when the terminal was acquired or created. */
	terminalCreatedAt: number
	/** Timestamp when the integrated shell process ID was resolved. */
	processIdResolvedAt?: number
	/** Timestamp when VS Code shell integration became available. */
	shellIntegrationActivatedAt?: number
	/** Timestamp when VS Code shell integration activation timed out. */
	shellIntegrationTimeoutAt?: number
	/** Timestamp when the command was submitted to the terminal/process. */
	commandSubmittedAt: number
	/** Timestamp when shell execution positively started. */
	shellExecutionStartedAt?: number
	/** Timestamp when the first output chunk was received. */
	firstOutputAt?: number
	/** Timestamp when shell execution ended. */
	shellExecutionEndedAt?: number

	// Status
	/** Whether shell integration was already available when the terminal was acquired. */
	shellIntegrationInitiallyAvailable: boolean
	/** Terminal provider used for the execution. */
	provider: RooTerminalProvider
	/** Whether an existing terminal was reused instead of creating a new one. */
	terminalReused: boolean
	/** Lifecycle state of the terminal before this execution acquired it. */
	priorTerminalState?: string

	// Error
	/** Exit code, if the command completed and a code was observed. */
	exitCode?: number
	/** Stable error type/code when the execution ended through an error path. */
	errorType?: string

	// Context
	/** Estimated number of concurrently executing commands. */
	concurrentCommandCount: number
	/** Estimated number of concurrent terminal creation operations. */
	concurrentTerminalCreationCount: number
	/** Length of the command string in characters. */
	commandLength: number
	/** Number of commands in the execution chain. */
	commandCountInChain: number

	// Queue
	/** Queue depth when the command entered the scheduler. */
	queueDepth: number
	/** Milliseconds the command spent waiting in the queue. */
	queueWaitMs: number
}

/**
 * Options for creating a {@link CommandTraceBuilder}.
 */
export interface CommandTraceBuilderOptions {
	executionId: string
	taskId: string
	modelId?: string
	commandLength: number
	commandCountInChain: number
	/**
	 * Optional callback invoked when the trace is finalized. If omitted, the
	 * trace is emitted through the default {@link CommandTraceCollector}.
	 */
	onComplete?: (trace: CommandTrace) => void
}

/**
 * Mutable builder for a {@link CommandTrace}. All fields default to safe
 * sentinel values (0, false, undefined) until explicitly set.
 */
export class CommandTraceBuilder {
	private readonly trace: Partial<CommandTrace>
	private readonly onComplete?: (trace: CommandTrace) => void
	private finalized = false

	constructor(options: CommandTraceBuilderOptions) {
		this.trace = {
			executionId: options.executionId,
			taskId: options.taskId,
			modelId: options.modelId,
			commandLength: options.commandLength,
			commandCountInChain: options.commandCountInChain,
			concurrentCommandCount: 0,
			concurrentTerminalCreationCount: 0,
			queueDepth: 0,
			queueWaitMs: 0,
		}
		this.onComplete = options.onComplete
	}

	markToolCallGeneratedAt(ts: number): this {
		this.trace.toolCallGeneratedAt = ts
		return this
	}

	markQueueEnteredAt(ts: number): this {
		this.trace.queueEnteredAt = ts
		return this
	}

	markQueueReleasedAt(ts: number): this {
		this.trace.queueReleasedAt = ts
		return this
	}

	markQueueDepth(depth: number): this {
		this.trace.queueDepth = depth
		return this
	}

	markQueueWaitMs(ms: number): this {
		this.trace.queueWaitMs = ms
		return this
	}

	markTerminalRequestedAt(ts: number): this {
		this.trace.terminalRequestedAt = ts
		return this
	}

	markTerminalCreatedAt(ts: number, reused: boolean, priorState?: string): this {
		this.trace.terminalCreatedAt = ts
		this.trace.terminalReused = reused
		this.trace.priorTerminalState = priorState
		return this
	}

	markProcessIdResolvedAt(ts: number): this {
		this.trace.processIdResolvedAt = ts
		return this
	}

	markShellIntegrationActivatedAt(ts: number): this {
		this.trace.shellIntegrationActivatedAt = ts
		this.trace.shellIntegrationInitiallyAvailable = true
		return this
	}

	markShellIntegrationTimeoutAt(ts: number): this {
		this.trace.shellIntegrationTimeoutAt = ts
		return this
	}

	markCommandSubmittedAt(ts: number): this {
		this.trace.commandSubmittedAt = ts
		return this
	}

	markShellExecutionStartedAt(ts: number): this {
		this.trace.shellExecutionStartedAt = ts
		return this
	}

	markFirstOutputAt(ts: number): this {
		this.trace.firstOutputAt = ts
		return this
	}

	markShellExecutionEndedAt(ts: number, exitCode?: number): this {
		this.trace.shellExecutionEndedAt = ts
		if (exitCode !== undefined) {
			this.trace.exitCode = exitCode
		}
		return this
	}

	markShellIntegrationInitiallyAvailable(available: boolean): this {
		this.trace.shellIntegrationInitiallyAvailable = available
		return this
	}

	markProvider(provider: RooTerminalProvider): this {
		this.trace.provider = provider
		return this
	}

	markConcurrentCommandCount(count: number): this {
		this.trace.concurrentCommandCount = count
		return this
	}

	markConcurrentTerminalCreationCount(count: number): this {
		this.trace.concurrentTerminalCreationCount = count
		return this
	}

	markError(errorType: string, exitCode?: number): this {
		this.trace.errorType = errorType
		if (exitCode !== undefined) {
			this.trace.exitCode = exitCode
		}
		return this
	}

	/**
	 * Builds and returns the immutable {@link CommandTrace}. Does not invoke the
	 * completion callback; use {@link finalize} to emit the trace.
	 */
	build(): CommandTrace {
		return {
			executionId: this.trace.executionId ?? "",
			taskId: this.trace.taskId ?? "",
			modelId: this.trace.modelId,
			toolCallGeneratedAt: this.trace.toolCallGeneratedAt ?? 0,
			queueEnteredAt: this.trace.queueEnteredAt ?? 0,
			queueReleasedAt: this.trace.queueReleasedAt ?? 0,
			terminalRequestedAt: this.trace.terminalRequestedAt ?? 0,
			terminalCreatedAt: this.trace.terminalCreatedAt ?? 0,
			processIdResolvedAt: this.trace.processIdResolvedAt,
			shellIntegrationActivatedAt: this.trace.shellIntegrationActivatedAt,
			shellIntegrationTimeoutAt: this.trace.shellIntegrationTimeoutAt,
			commandSubmittedAt: this.trace.commandSubmittedAt ?? 0,
			shellExecutionStartedAt: this.trace.shellExecutionStartedAt,
			firstOutputAt: this.trace.firstOutputAt,
			shellExecutionEndedAt: this.trace.shellExecutionEndedAt,
			shellIntegrationInitiallyAvailable: this.trace.shellIntegrationInitiallyAvailable ?? false,
			provider: this.trace.provider ?? "vscode",
			terminalReused: this.trace.terminalReused ?? false,
			priorTerminalState: this.trace.priorTerminalState,
			exitCode: this.trace.exitCode,
			errorType: this.trace.errorType,
			concurrentCommandCount: this.trace.concurrentCommandCount ?? 0,
			concurrentTerminalCreationCount: this.trace.concurrentTerminalCreationCount ?? 0,
			commandLength: this.trace.commandLength ?? 0,
			commandCountInChain: this.trace.commandCountInChain ?? 1,
			queueDepth: this.trace.queueDepth ?? 0,
			queueWaitMs: this.trace.queueWaitMs ?? 0,
		}
	}

	/**
	 * Finalizes the trace, invokes the completion callback if provided, and emits
	 * to the default collector. Idempotent: subsequent calls return the same
	 * trace without re-emitting.
	 */
	finalize(): CommandTrace {
		if (this.finalized) {
			return this.build()
		}

		this.finalized = true
		const trace = this.build()

		if (this.onComplete) {
			this.onComplete(trace)
		} else {
			CommandTraceCollector.getInstance().emit(trace)
		}

		return trace
	}
}

/**
 * Listener type for command trace events. Emissions may be partial (e.g.
 * watchdog or provider-switch diagnostics) so all fields are optional except
 * executionId and taskId, which are required for correlation.
 */
export type CommandTraceListener = (trace: Partial<CommandTrace> & { executionId: string; taskId: string }) => void

/**
 * Global collector for command trace events. Multiple subscribers can listen
 * for diagnostic or final traces without coupling producers to consumers.
 */
export class CommandTraceCollector {
	private static instance?: CommandTraceCollector
	private listeners: CommandTraceListener[] = []

	static getInstance(): CommandTraceCollector {
		if (!CommandTraceCollector.instance) {
			CommandTraceCollector.instance = new CommandTraceCollector()
		}
		return CommandTraceCollector.instance
	}

	/**
	 * Subscribes to trace events. Returns a disposal function.
	 */
	subscribe(listener: CommandTraceListener): () => void {
		this.listeners.push(listener)
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener)
		}
	}

	/**
	 * Emits a trace to all subscribers. Safe to call even when no listeners are
	 * registered.
	 */
	emit(trace: Partial<CommandTrace> & { executionId: string; taskId: string }): void {
		for (const listener of this.listeners) {
			try {
				listener(trace)
			} catch (error) {
				console.error("[CommandTraceCollector] listener threw:", error)
			}
		}
	}
}

/**
 * Emits a diagnostic command trace to the default collector. Convenience
 * wrapper around {@link CommandTraceCollector.getInstance().emit}.
 */
export function emitCommandTrace(trace: Partial<CommandTrace> & { executionId: string; taskId: string }): void {
	CommandTraceCollector.getInstance().emit(trace)
}
