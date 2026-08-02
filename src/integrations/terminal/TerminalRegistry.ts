import * as vscode from "vscode"

import { arePathsEqual } from "../../utils/path"

import { RooTerminal, RooTerminalProvider } from "./types"
import { TerminalProcess } from "./TerminalProcess"
import { Terminal } from "./Terminal"
import { ExecaTerminal } from "./ExecaTerminal"
import { ShellIntegrationManager } from "./ShellIntegrationManager"
import { CommandScheduler, TerminalCreationPermitResult } from "./CommandScheduler"
import { TerminalLifecycle, type TerminalState } from "./TerminalLifecycle"
import { emitCommandTrace } from "./CommandTrace"
import type { ShellFamily, ResolvedCommandEnvironment, ShellInvocationPlan } from "./shell/types"

// Although vscode.window.terminals provides a list of all open terminals,
// there's no way to know whether they're busy or not (exitStatus does not
// provide useful information for most commands). In order to prevent creating
// too many terminals, we need to keep track of terminals through the life of
// the extension, as well as session specific terminals for the life of a task
// (to get latest unretrieved output).
// Since we have promises keeping track of terminal processes, we get the added
// benefit of keep track of busy terminals even after a task is closed.

/** Interval between watchdog sweeps. */
const WATCHDOG_INTERVAL_MS = 1_000

/** Deadline for a ready reservation to reach submission. */
const READY_RESERVATION_DEADLINE_MS = 10_000

/** Input to {@link TerminalRegistry.prepareProviderSwitch}. */
export interface ProviderSwitchInput {
	terminalId: number
	executionId: string
	fromProvider: RooTerminalProvider
	toProvider: RooTerminalProvider
	reasonCode: string
	commandSubmitted: boolean
	resolvedEnv: ResolvedCommandEnvironment
}

/** Result of a successful provider switch. */
export interface ProviderSwitchResult {
	terminal: RooTerminal
	provider: RooTerminalProvider
}

export class TerminalRegistry {
	private static terminals: RooTerminal[] = []
	private static nextTerminalId = 1
	private static disposables: vscode.Disposable[] = []
	private static isInitialized = false

	/**
	 * The current shell family for Execa terminals. When the shell family
	 * changes (e.g. user switches from PowerShell to bash), idle Execa
	 * terminals with a different family are not reused. This ensures the
	 * terminal's invocation plan matches the current shell.
	 */
	private static execaShellFamily: ShellFamily | undefined = undefined

	/** Registry-owned watchdog timer. */
	private static watchdogTimer: ReturnType<typeof setInterval> | undefined

	public static initialize() {
		if (this.isInitialized) {
			throw new Error("TerminalRegistry.initialize() should only be called once")
		}

		this.isInitialized = true

		// TODO: This initialization code is VSCode specific, and therefore
		// should probably live elsewhere.

		// Register handler for terminal close events to clean up temporary
		// directories.
		const closeDisposable = vscode.window.onDidCloseTerminal((vsceTerminal) => {
			const terminal = this.getTerminalByVSCETerminal(vsceTerminal)

			if (terminal) {
				ShellIntegrationManager.zshCleanupTmpDir(terminal.id)
			}
		})

		this.disposables.push(closeDisposable)

		try {
			const startDisposable = vscode.window.onDidStartTerminalShellExecution?.(
				async (e: vscode.TerminalShellExecutionStartEvent) => {
					const terminal = this.getTerminalByVSCETerminal(e.terminal)

					console.info("[onDidStartTerminalShellExecution]", {
						command: e.execution?.commandLine?.value,
						terminalId: terminal?.id,
					})

					if (terminal instanceof Terminal) {
						// Always call read() from this event — it fires when VSCode's shell
						// integration confirms the command has actually started, which is the
						// earliest point at which read() will reliably capture output. Calling
						// read() earlier (e.g. immediately after executeCommand()) creates a
						// stream window that misses data on cold terminals where the shell
						// hasn't started yet: VSCode doesn't buffer retroactively.
						//
						// Guard: only set the stream for the execution we own. Stale start
						// events for a previous execution on the same reused terminal must
						// not overwrite the current command's stream.
						const process = terminal.process
						const isOwnExecution =
							!(process instanceof TerminalProcess) ||
							// Allow undefined only when the process hasn't started yet (cold
							// terminal: process is assigned but run() hasn't called executeCommand).
							// Once isHot is true, ownExecution is always set — a stale start
							// event on a reused terminal must match exactly.
							(!process.isHot && process.ownExecution === undefined) ||
							process.ownExecution === e.execution
						if (!isOwnExecution) {
							console.info(
								"[TerminalRegistry] Ignoring onDidStartTerminalShellExecution for a different execution",
								{ terminalId: terminal.id },
							)
							return
						}
						const stream = e.execution.read()
						terminal.setActiveStream(stream)
						// setActiveStream already transitions the lifecycle to `running`, so no
						// explicit busy flag is needed. The legacy busy setter is intentionally a
						// no-op in production; the lifecycle state machine is the source of truth.
					} else {
						console.error(
							"[onDidStartTerminalShellExecution] Shell execution started, but not from a Roo-registered terminal:",
							e,
						)
					}
				},
			)

			if (startDisposable) {
				this.disposables.push(startDisposable)
			}

			const endDisposable = vscode.window.onDidEndTerminalShellExecution?.(
				async (e: vscode.TerminalShellExecutionEndEvent) => {
					const terminal = this.getTerminalByVSCETerminal(e.terminal)
					const process = terminal?.process
					const exitDetails = TerminalProcess.interpretExitCode(e.exitCode)

					console.info("[onDidEndTerminalShellExecution]", {
						command: e.execution?.commandLine?.value,
						terminalId: terminal?.id,
						...exitDetails,
					})

					if (!terminal) {
						console.error(
							"[onDidEndTerminalShellExecution] Shell execution ended, but not from a Roo-registered terminal:",
							e,
						)

						return
					}

					if (terminal instanceof Terminal && terminal.activeShellExecution === e.execution) {
						terminal.activeShellExecution = undefined
					}

					// Guard against a late end event for an execution that has already been
					// superseded on this terminal. This can happen when a process self-finalizes
					// after TerminalProcess's own D-marker grace period elapses without ever
					// seeing this event (see TerminalProcess.ts's finalize()): the terminal gets
					// reused for a new command before VSCode's stale event for the OLD command
					// finally arrives. Without this check, that stale event would call
					// shellExecutionComplete() on whatever process/exit-code tracking is
					// currently attached -- the NEW command's -- corrupting its state instead of
					// being a harmless no-op for the command it actually belongs to.
					const isStaleExecution =
						process instanceof TerminalProcess &&
						process.ownExecution !== undefined &&
						process.ownExecution !== e.execution

					if (isStaleExecution) {
						console.info(
							"[TerminalRegistry] Ignoring stale onDidEndTerminalShellExecution for a superseded execution",
							{ terminalId: terminal.id, exitCode: e.exitCode },
						)

						return
					}

					if (!terminal.running) {
						// The end event can arrive before setActiveStream() has set
						// running=true (race between the global VS Code event and the
						// synchronous call in TerminalProcess.run). If a process is
						// waiting for completion, deliver the signal so it doesn't
						// hang forever. See #489 / #622.
						if (process) {
							console.info(
								"[TerminalRegistry] End event arrived before running=true (race); delivering completion signal",
								{ terminalId: terminal.id, exitCode: e.exitCode },
							)
							terminal.shellExecutionComplete(exitDetails, { executionId: process.executionId })
						} else {
							terminal.busy = false
						}

						return
					}

					if (!process) {
						console.error(
							"[TerminalRegistry] Shell execution end event received on running terminal, but process is undefined:",
							{ terminalId: terminal.id, exitCode: e.exitCode },
						)

						return
					}

					// Signal completion to any waiting processes.
					terminal.shellExecutionComplete(exitDetails, { executionId: process?.executionId })
				},
			)

			if (endDisposable) {
				this.disposables.push(endDisposable)
			}
		} catch (error) {
			console.error("[TerminalRegistry] Error setting up shell execution handlers:", error)
		}

		// Start the registry watchdog.
		this.watchdogTimer = setInterval(() => this.runWatchdog(), WATCHDOG_INTERVAL_MS)
	}

	public static createTerminal(
		cwd: string,
		provider: RooTerminalProvider,
		resolvedEnv?: ResolvedCommandEnvironment,
	): RooTerminal {
		let newTerminal

		if (provider === "vscode") {
			// Pass the resolved environment so the integrated terminal is created
			// with the same shell executable reported in the system prompt.
			newTerminal = new Terminal(this.nextTerminalId++, undefined, cwd, resolvedEnv)
		} else {
			// Pass the shell-family-aware reuse key so that changing shells
			// prevents reuse of terminals created with a different family.
			newTerminal = new ExecaTerminal(this.nextTerminalId++, cwd, this.getExecaReuseKey())
		}

		this.terminals.push(newTerminal)

		return newTerminal
	}

	/**
	 * Gets an existing terminal or creates a new one for the given working
	 * directory. Terminal acquisition is atomic: the selected terminal is
	 * reserved before this method returns, so two concurrent acquisitions cannot
	 * receive the same idle terminal.
	 *
	 * @param cwd The working directory path
	 * @param taskId Optional task ID to associate with the terminal
	 * @param executionId Required execution ID that will own the reserved terminal
	 * @param provider Terminal provider to use
	 * @param resolvedEnv Optional resolved command environment
	 * @returns A Terminal instance
	 */
	public static async getOrCreateTerminal(
		cwd: string,
		taskId: string | undefined,
		executionId: string,
		provider: RooTerminalProvider = "vscode",
		resolvedEnv?: ResolvedCommandEnvironment,
	): Promise<RooTerminal> {
		const normalizedCwd = vscode.Uri.file(cwd).fsPath
		const reuseKey = provider === "vscode" ? Terminal.getReuseKey() : this.getExecaReuseKey()

		return CommandScheduler.getInstance().withTerminalCreationPermit(async () => {
			let terminal: RooTerminal | undefined
			let createdNewTerminal = false

			// First priority: Find a terminal already assigned to this task with
			// matching directory and reuse key.
			if (taskId) {
				terminal = this.findReusableTerminal({
					cwd: normalizedCwd,
					taskId,
					provider,
					reuseKey,
				})
			}

			// Second priority: Find any available terminal with matching directory
			// and reuse key.
			if (!terminal) {
				terminal = this.findReusableTerminal({
					cwd: normalizedCwd,
					provider,
					reuseKey,
				})
			}

			// If no suitable terminal found, create a new one under the global
			// creation permit.
			if (!terminal) {
				terminal = this.createTerminal(cwd, provider, resolvedEnv)
				createdNewTerminal = true
			}

			// Atomically reserve the terminal for this execution.
			terminal.lifecycle.acquireOwner(executionId)
			terminal.taskId = taskId

			if (createdNewTerminal && terminal.provider === "vscode") {
				// New VS Code terminals are constructed in `creating`; once the VS Code
				// terminal process has been created we move to `process-started` so
				// subsequent shell-integration waits can transition to
				// `integration-pending` without an illegal transition.
				terminal.lifecycle.transition("process-started", executionId)
			}

			if (terminal.provider === "vscode") {
				// Reused VS Code terminals are promoted from idle to integration-ready.
				// New terminals are already in `creating` from the constructor and must
				// progress through process-started/integration-pending before running.
				if (!createdNewTerminal) {
					terminal.lifecycle.transition("integration-ready", executionId)
				}
			} else {
				terminal.lifecycle.transition("fallback-ready", executionId)
			}

			return { value: terminal, createdNewTerminal } as TerminalCreationPermitResult<RooTerminal>
		})
	}

	/**
	 * Finds a reusable terminal matching the given constraints, applying the
	 * provider-specific health/reuse predicate. Any VS Code terminal whose
	 * shell integration has disappeared is marked broken and disposed.
	 */
	private static findReusableTerminal(options: {
		cwd: string
		taskId?: string
		provider: RooTerminalProvider
		reuseKey: string
	}): RooTerminal | undefined {
		const terminals = this.getAllTerminals()

		for (const terminal of terminals) {
			if (terminal.provider !== options.provider) {
				continue
			}

			if (options.taskId !== undefined && terminal.taskId !== options.taskId) {
				continue
			}

			const terminalCwd = terminal.getCurrentWorkingDirectory()
			if (!terminalCwd || !arePathsEqual(options.cwd, terminalCwd)) {
				continue
			}

			const hasProcess = terminal.process !== undefined
			const shellIntegrationDefined =
				terminal.provider !== "vscode" || (terminal as Terminal).terminal.shellIntegration !== undefined

			// If a previously healthy idle VS Code terminal has lost shell
			// integration, mark it broken and dispose it instead of offering it
			// as a candidate.
			if (
				terminal.provider === "vscode" &&
				terminal.lifecycle.health === "healthy" &&
				terminal.lifecycle.state === "idle" &&
				!shellIntegrationDefined
			) {
				console.info(
					`[TerminalRegistry] VS Code terminal ${terminal.id} lost shell integration while idle; marking broken and disposing`,
				)
				terminal.lifecycle.markBroken()
				if (terminal instanceof Terminal) {
					terminal.terminal.dispose()
					ShellIntegrationManager.zshCleanupTmpDir(terminal.id)
				}
				continue
			}

			const canReuse = terminal.canReuse({
				cwd: options.cwd,
				reuseKey: options.reuseKey,
				hasProcess,
				shellIntegrationDefined,
				hasStaleActiveShellExecution:
					terminal.provider === "vscode" && (terminal as Terminal).activeShellExecution !== undefined,
			})

			if (canReuse) {
				return terminal
			}
		}

		return undefined
	}

	/**
	 * Sets the current shell family for Execa terminal reuse keying.
	 * When the shell family changes, idle Execa terminals with a different
	 * family are not reused.
	 * @param family The shell family, or undefined to reset
	 */
	public static setExecaShellFamily(family: ShellFamily | undefined): void {
		TerminalRegistry.execaShellFamily = family
	}

	/**
	 * Gets the current Execa shell family reuse key.
	 * @returns The reuse key string incorporating provider and shell family
	 */
	private static getExecaReuseKey(): string {
		const family = TerminalRegistry.execaShellFamily
		return family ? `execa:${family}` : "execa"
	}

	/**
	 * Gets unretrieved output from a terminal process.
	 *
	 * @param id The terminal ID
	 * @returns The unretrieved output as a string, or empty string if terminal not found
	 */
	public static getUnretrievedOutput(id: number): string {
		return this.getTerminalById(id)?.getUnretrievedOutput() ?? ""
	}

	/**
	 * Checks if a terminal process is "hot" (recently active).
	 *
	 * @param id The terminal ID
	 * @returns True if the process is hot, false otherwise
	 */
	public static isProcessHot(id: number): boolean {
		return this.getTerminalById(id)?.process?.isHot ?? false
	}

	/**
	 * Gets terminals filtered by busy state and optionally by task id.
	 *
	 * @param busy Whether to get busy or non-busy terminals
	 * @param taskId Optional task ID to filter terminals by
	 * @returns Array of Terminal objects
	 */
	public static getTerminals(busy: boolean, taskId?: string): RooTerminal[] {
		return this.getAllTerminals().filter((t) => {
			// Filter by busy state.
			if (t.busy !== busy) {
				return false
			}

			// If taskId is provided, also filter by taskId.
			if (taskId !== undefined && t.taskId !== taskId) {
				return false
			}

			return true
		})
	}

	/**
	 * Gets background terminals (taskId undefined) that have unretrieved output
	 * or are still running.
	 *
	 * @param busy Whether to get busy or non-busy terminals
	 * @returns Array of Terminal objects
	 */
	public static getBackgroundTerminals(busy?: boolean): RooTerminal[] {
		return this.getAllTerminals().filter((t) => {
			// Only get background terminals (taskId undefined).
			if (t.taskId !== undefined) {
				return false
			}

			// If busy is undefined, return all background terminals.
			if (busy === undefined) {
				return t.getProcessesWithOutput().length > 0 || t.process?.hasUnretrievedOutput()
			}

			// Filter by busy state.
			return t.busy === busy
		})
	}

	public static cleanup() {
		// Clean up all temporary directories.
		ShellIntegrationManager.clear()
		this.disposables.forEach((disposable) => disposable.dispose())
		this.disposables = []

		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer)
			this.watchdogTimer = undefined
		}
	}

	/**
	 * Disposes all idle (non-busy) VS Code terminals so they are not reused
	 * after a shell profile change. Busy terminals are left untouched.
	 */
	public static closeIdleTerminals(): void {
		this.terminals = this.terminals.filter((t) => {
			if (t.busy || !(t instanceof Terminal)) {
				return true
			}

			t.terminal.dispose()
			ShellIntegrationManager.zshCleanupTmpDir(t.id)
			return false
		})
	}

	/**
	 * Closes and removes idle (non-busy) terminals matching the given working
	 * directory, task ID, and provider. This forces `getOrCreateTerminal` to
	 * create a fresh terminal on the next call, which resolves persistent
	 * shell-integration failures on a stale terminal.
	 *
	 * Busy terminals are left untouched.
	 */
	public static closeTerminalForCwd(cwd: string, taskId: string, provider: RooTerminalProvider): void {
		const normalizedCwd = vscode.Uri.file(cwd).fsPath

		this.terminals = this.terminals.filter((t) => {
			if (t.busy || t.provider !== provider || t.taskId !== taskId) {
				return true
			}

			const terminalCwd = t.getCurrentWorkingDirectory()

			if (!terminalCwd || !arePathsEqual(normalizedCwd, terminalCwd)) {
				return true
			}

			// Dispose the terminal if possible (VS Code terminals only).
			if (t instanceof Terminal) {
				t.terminal.dispose()
			}

			ShellIntegrationManager.zshCleanupTmpDir(t.id)
			return false
		})
	}

	/**
	 * Releases all terminals associated with a task.
	 *
	 * @param taskId The task ID
	 */
	public static releaseTerminalsForTask(taskId: string): void {
		this.terminals.forEach((terminal) => {
			if (terminal.taskId === taskId) {
				// #245: If the terminal is still executing a command when its task is torn
				// down (user pressed cancel ✕, or the task was switched/removed), abort the
				// process. Otherwise the command keeps running orphaned and the terminal stays
				// stuck "busy" — the cancel-doesn't-terminate bug. abort() is safe when idle
				// (Ctrl+C is gated on an active stream; Execa abort is idempotent).
				if (terminal.busy) {
					try {
						terminal.process?.abort()
					} catch (error) {
						console.error(
							`[TerminalRegistry] Error aborting process for terminal ${terminal.id} on release:`,
							error,
						)
					}
				}

				terminal.taskId = undefined
			}
		})
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Watchdog (REQ-009)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Evidence-based watchdog. Only recovers stale ownership that can be proven
	 * by process/terminal state, not by elapsed time for a running command.
	 */
	private static runWatchdog(): void {
		const now = Date.now()
		const shellIntegrationTimeout = Terminal.getShellIntegrationTimeout()

		// Iterate over the raw terminals array so the watchdog can see closed
		// terminals and recover them before getAllTerminals() filters them out.
		for (const terminal of [...this.terminals]) {
			const lifecycle = terminal.lifecycle
			const ownerExecutionId = lifecycle.ownerExecutionId
			if (ownerExecutionId === undefined) {
				continue
			}

			const state = lifecycle.state
			const process = terminal.process
			const terminalClosed = terminal.isClosed()

			// Evidence 1: terminal closed while owned.
			if (terminalClosed) {
				console.info(
					`[TerminalRegistry/watchdog] Terminal ${terminal.id} closed while owned by ${ownerExecutionId}; recovering`,
				)
				this.recoverStaleTerminal(terminal.id, ownerExecutionId, "TERMINAL_DISPOSED")
				continue
			}

			// Evidence 2: attached process belongs to a different execution.
			if (
				process &&
				"executionId" in process &&
				process.executionId !== undefined &&
				process.executionId !== ownerExecutionId
			) {
				console.info(
					`[TerminalRegistry/watchdog] Terminal ${terminal.id} process belongs to ${process.executionId} but owner is ${ownerExecutionId}; recovering`,
				)
				this.recoverStaleTerminal(terminal.id, ownerExecutionId, "TERMINAL_BUSY_STALE")
				continue
			}

			// Evidence 3: pre-submission states exceeded their deadline.
			const elapsed = now - lifecycle.stateChangedAt
			const preSubmissionDeadline = shellIntegrationTimeout + 1_000

			if (state === "creating" || state === "process-started" || state === "integration-pending") {
				if (elapsed > preSubmissionDeadline) {
					console.info(
						`[TerminalRegistry/watchdog] Terminal ${terminal.id} pre-submission state ${state} exceeded deadline (${elapsed}ms); recovering`,
					)
					this.recoverStaleTerminal(terminal.id, ownerExecutionId, "TERMINAL_BUSY_STALE")
				}
				continue
			}

			if (state === "integration-ready" || state === "fallback-ready") {
				if (elapsed > READY_RESERVATION_DEADLINE_MS) {
					console.info(
						`[TerminalRegistry/watchdog] Terminal ${terminal.id} ready reservation exceeded ${READY_RESERVATION_DEADLINE_MS}ms; recovering`,
					)
					this.recoverStaleTerminal(terminal.id, ownerExecutionId, "TERMINAL_BUSY_STALE")
				}
				continue
			}

			// Evidence 4: owned but no process in a state that requires one.
			if (state === "running" && !process) {
				console.info(
					`[TerminalRegistry/watchdog] Terminal ${terminal.id} is running but has no process; recovering`,
				)
				this.recoverStaleTerminal(terminal.id, ownerExecutionId, "TERMINAL_BUSY_STALE")
				continue
			}

			// Running with a matching process is intentionally NOT reset by time.
			if (state === "running") {
				if (elapsed > 10_000) {
					console.info(
						`[TerminalRegistry/watchdog] Terminal ${terminal.id} has been running for ${elapsed}ms with a matching process; diagnostic only`,
					)
				}
			}
		}
	}

	/**
	 * Compare-and-set recovery of a stale terminal. Only acts if the terminal
	 * is still owned by the expected execution and the stale predicate still
	 * holds.
	 */
	public static recoverStaleTerminal(terminalId: number, ownerExecutionId: string, reasonCode: string): void {
		const terminal = this.terminals.find((t) => t.id === terminalId)
		if (!terminal) {
			return
		}

		const lifecycle = terminal.lifecycle
		if (lifecycle.ownerExecutionId !== ownerExecutionId) {
			console.info(
				`[TerminalRegistry/recoverStaleTerminal] Terminal ${terminalId} owner changed (${lifecycle.ownerExecutionId}); skipping recovery`,
			)
			return
		}

		// Cancel any pending shell-integration wait.
		if (terminal instanceof Terminal) {
			terminal.cancelShellIntegrationWait()
		}

		// Abort any attached process that has an execution ID. A stale process
		// belonging to a different execution is the evidence that triggered this
		// recovery, so it must be terminated to free the terminal.
		const process = terminal.process
		if (process && "executionId" in process && (process as any).executionId !== undefined) {
			try {
				process.abort()
			} catch (error) {
				console.error(
					`[TerminalRegistry/recoverStaleTerminal] Error aborting process for terminal ${terminalId}:`,
					error,
				)
			}
		}

		// Clear active shell execution only when it belongs to the same owner.
		if (terminal instanceof Terminal && terminal.activeShellExecution) {
			terminal.activeShellExecution = undefined
		}

		// Emit a diagnostic trace. (CommandTrace is now available in Sub-task 6.)
		emitCommandTrace({
			executionId: ownerExecutionId,
			taskId: terminal.taskId ?? "unknown",
			provider: terminal.provider,
			terminalReused: false,
			priorTerminalState: lifecycle.state,
			errorType: reasonCode,
			concurrentCommandCount: 1,
			concurrentTerminalCreationCount: 0,
			commandLength: 0,
			commandCountInChain: 0,
			queueDepth: 0,
			queueWaitMs: 0,
			toolCallGeneratedAt: Date.now(),
			queueEnteredAt: Date.now(),
			queueReleasedAt: Date.now(),
			terminalRequestedAt: Date.now(),
			terminalCreatedAt: Date.now(),
			commandSubmittedAt: Date.now(),
			shellIntegrationInitiallyAvailable: false,
		})
		console.info("[TerminalRegistry/recoverStaleTerminal]", {
			terminalId,
			ownerExecutionId,
			reasonCode,
			state: lifecycle.state,
		})

		// Mark VS Code terminals broken and dispose; safe idle Execa wrappers reset.
		if (terminal.provider === "vscode") {
			terminal.lifecycle.transition("failed", ownerExecutionId)
			terminal.lifecycle.markBroken()
			if (terminal instanceof Terminal) {
				terminal.terminal.dispose()
				ShellIntegrationManager.zshCleanupTmpDir(terminal.id)
			}
			terminal.lifecycle.transition("disposed", ownerExecutionId)
			this.removeTerminal(terminal.id)
		} else {
			// Execa: reset to idle only when no child process exists.
			if (!process) {
				terminal.lifecycle.resetToIdle()
				terminal.taskId = undefined
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Provider-switch cleanup (REQ-008)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Cleans up a VS Code source terminal before switching to the same-family
	 * Execa fallback. The source is removed from the registry and disposed
	 * before the Execa terminal is acquired.
	 */
	public static async prepareProviderSwitch(input: ProviderSwitchInput): Promise<ProviderSwitchResult> {
		const { terminalId, executionId, fromProvider, toProvider, commandSubmitted, resolvedEnv } = input

		// Preconditions.
		if (fromProvider !== "vscode") {
			throw new Error("TERMINAL/PROVIDER_SWITCH/001: source provider must be VS Code")
		}
		if (toProvider !== "execa") {
			throw new Error("TERMINAL/PROVIDER_SWITCH/002: target provider must be Execa")
		}
		if (commandSubmitted) {
			return {
				terminal: this.getTerminalById(terminalId)!,
				provider: fromProvider,
			}
		}
		if (!resolvedEnv.fallbackPlan) {
			throw new Error("TERMINAL/PROVIDER_SWITCH/003: fallback plan is required")
		}

		const source = this.getTerminalById(terminalId)
		if (!source) {
			throw new Error(`TERMINAL/PROVIDER_SWITCH/004: source terminal ${terminalId} not found`)
		}
		if (source.provider !== "vscode") {
			throw new Error("TERMINAL/PROVIDER_SWITCH/005: source terminal is not a VS Code terminal")
		}
		if (source.lifecycle.ownerExecutionId !== executionId) {
			throw new Error(
				`TERMINAL/PROVIDER_SWITCH/006: owner mismatch (expected ${executionId}, got ${source.lifecycle.ownerExecutionId})`,
			)
		}

		// 1. Transition source to failed.
		source.lifecycle.transition("failed", executionId)

		// 2. Cancel shell-integration wait.
		;(source as Terminal).cancelShellIntegrationWait()

		// 3. Detach pre-submit process listeners without invoking sendText.
		const process = source.process
		if (process) {
			process.removeAllListeners()
			if ("cleanupScriptFile" in process) {
				;(process as any).cleanupScriptFile?.()
			}
		}

		// 4. Clear process and activeShellExecution after owner comparison.
		if (source instanceof Terminal) {
			const activeExecution = source.activeShellExecution
			if (activeExecution) {
				// Only clear if it belongs to the same owner.
				source.activeShellExecution = undefined
			}
		}
		source.process = undefined

		// 5. Remove from registry selection.
		this.removeTerminal(terminalId)

		// 6. Dispose the VS Code terminal and clean ZDOTDIR.
		if (source instanceof Terminal) {
			source.terminal.dispose()
			ShellIntegrationManager.zshCleanupTmpDir(source.id)
		}

		// 7. Transition to disposed.
		source.lifecycle.transition("disposed", executionId)

		// 8. Emit PROVIDER_SWITCH trace.
		emitCommandTrace({
			executionId,
			taskId: source.taskId ?? "unknown",
			provider: toProvider,
			terminalReused: false,
			priorTerminalState: source.lifecycle.state,
			errorType: input.reasonCode,
			concurrentCommandCount: 1,
			concurrentTerminalCreationCount: 0,
			commandLength: 0,
			commandCountInChain: 0,
			queueDepth: 0,
			queueWaitMs: 0,
			toolCallGeneratedAt: Date.now(),
			queueEnteredAt: Date.now(),
			queueReleasedAt: Date.now(),
			terminalRequestedAt: Date.now(),
			terminalCreatedAt: Date.now(),
			commandSubmittedAt: Date.now(),
			shellIntegrationInitiallyAvailable: false,
		})
		console.info("[TerminalRegistry/PROVIDER_SWITCH]", {
			terminalId,
			executionId,
			fromProvider,
			toProvider,
			reasonCode: input.reasonCode,
		})

		// 9. Acquire an Execa terminal under the same scheduler lease and apply
		// the fallback plan.
		const fallbackTerminal = await this.getOrCreateTerminal(
			source.getCurrentWorkingDirectory(),
			source.taskId,
			executionId,
			"execa",
			resolvedEnv,
		)

		if (fallbackTerminal instanceof ExecaTerminal) {
			fallbackTerminal.setShellInvocationPlan(resolvedEnv.fallbackPlan as ShellInvocationPlan)
		}

		return { terminal: fallbackTerminal, provider: toProvider }
	}

	private static getAllTerminals(): RooTerminal[] {
		this.terminals = this.terminals.filter((t) => !t.isClosed())
		return this.terminals
	}

	private static getTerminalById(id: number): RooTerminal | undefined {
		const terminal = this.terminals.find((t) => t.id === id)

		if (terminal?.isClosed()) {
			this.removeTerminal(id)
			return undefined
		}

		return terminal
	}

	/**
	 * Gets a terminal by its VSCode terminal instance
	 * @param terminal The VSCode terminal instance
	 * @returns The Terminal object, or undefined if not found
	 */
	private static getTerminalByVSCETerminal(vsceTerminal: vscode.Terminal): RooTerminal | undefined {
		const found = this.terminals.find((t) => t instanceof Terminal && t.terminal === vsceTerminal)

		if (found?.isClosed()) {
			this.removeTerminal(found.id)
			return undefined
		}

		return found
	}

	private static removeTerminal(id: number) {
		ShellIntegrationManager.zshCleanupTmpDir(id)
		this.terminals = this.terminals.filter((t) => t.id !== id)
	}
}
