import fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import delay from "delay"

import {
	CommandExecutionStatus,
	DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
	PersistedCommandOutput,
	getModelId,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"

import { ToolUse, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { parseCommand } from "../../shared/parse-command"
import {
	ExitCodeDetails,
	RooTerminal,
	RooTerminalCallbacks,
	RooTerminalProvider,
	RooTerminalProcess,
	ShellIntegrationError,
	ShellIntegrationErrorDetails,
	TerminalErrorCode,
	TerminalExecutionError,
} from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { CommandScheduler } from "../../integrations/terminal/CommandScheduler"
import { Terminal } from "../../integrations/terminal/Terminal"
import { ExecaTerminal } from "../../integrations/terminal/ExecaTerminal"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { CommandTraceBuilder } from "../../integrations/terminal/CommandTrace"
import { Package } from "../../shared/package"
import { t } from "../../i18n"
import { getTaskDirectoryPath } from "../../utils/storage"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ResolvedCommandEnvironment, ShellInvocationPlan } from "../../integrations/terminal/shell/types"

export { ShellIntegrationError } from "../../integrations/terminal/types"

export function canRetryShellIntegrationError(error: unknown): error is ShellIntegrationError {
	return error instanceof ShellIntegrationError && error.retryDisposition !== "never"
}

/**
 * Error thrown when shell integration fails and no same-family fallback plan
 * is available. The command must NOT be retried under a different shell family.
 */
export class ShellFallbackMismatchError extends Error {
	readonly code = "SHELL_FALLBACK_MISMATCH" as const
	readonly primaryFamily: string
	readonly fallbackFamily: string | undefined

	constructor(primaryFamily: string, fallbackFamily: string | undefined) {
		super(
			`SHELL_FALLBACK_MISMATCH: Primary shell family "${primaryFamily}" has no compatible fallback` +
				(fallbackFamily ? ` (fallback family: "${fallbackFamily}")` : " (no fallback plan available)") +
				". Command was not executed.",
		)
		this.name = "ShellFallbackMismatchError"
		this.primaryFamily = primaryFamily
		this.fallbackFamily = fallbackFamily
	}
}

/**
 * Grace period before a foreground command may trigger a `command_output` ask.
 * Short commands that emit output and exit within this window never prompt the
 * user; the ask only fires when the command is still running once the delay
 * elapses, so users can still interrupt or provide feedback on long-running
 * commands.
 */
export const COMMAND_OUTPUT_ASK_DELAY_MS = 5_000

/**
 * Determines the terminal provider for command execution.
 *
 * When a {@link ResolvedCommandEnvironment} is provided, the provider is
 * determined from `primaryPlan.provider` — this is the single source of truth
 * that matches the system prompt and tool description.
 *
 * When no environment is provided (legacy callers), falls back to the
 * original `terminalShellIntegrationDisabled` + `isActiveShellCmdExe()` logic.
 *
 * @param terminalShellIntegrationDisabled Whether shell integration is disabled.
 * @param env Optional resolved command environment snapshot.
 * @returns The terminal provider and whether this is a cmd.exe fallback.
 */
export function getTerminalProviderForExecution(
	terminalShellIntegrationDisabled: boolean,
	env?: ResolvedCommandEnvironment,
): {
	terminalProvider: RooTerminalProvider
	isCmdExeFallback: boolean
} {
	// When a resolved environment is available, use its primary plan provider.
	// This ensures the execution provider matches what the system prompt told the model.
	if (env) {
		const terminalProvider = env.primaryPlan.provider
		const isCmdExeFallback = terminalProvider === "execa" && env.primaryPlan.family === "cmd"
		return { terminalProvider, isCmdExeFallback }
	}

	// Legacy path: no resolved environment available.
	const isCmdExeFallback = !terminalShellIntegrationDisabled && Terminal.isActiveShellCmdExe()
	const terminalProvider = terminalShellIntegrationDisabled || isCmdExeFallback ? "execa" : "vscode"

	return { terminalProvider, isCmdExeFallback }
}

interface ExecuteCommandParams {
	command: string
	cwd?: string
	timeout?: number | null
}

export function resolveAgentTimeoutMs(timeoutSeconds: number | null | undefined): number {
	const requestedAgentTimeout = typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0

	// In CLI runtime, stdin harnesses expect command lifetime to be governed
	// solely by commandExecutionTimeout (user setting), not model-provided
	// background timeouts.
	return process.env.ROO_CLI_RUNTIME === "1" ? 0 : requestedAgentTimeout
}

export class ExecuteCommandTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const

	async execute(params: ExecuteCommandParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { command, cwd: customCwd, timeout: timeoutSeconds } = params
		const { handleError, pushToolResult, askApproval } = callbacks

		try {
			// Runtime type validation — LLM may send malformed parameters
			if (typeof command !== "string" || command.trim().length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_command", "command"))
				return
			}

			if (customCwd !== undefined && (typeof customCwd !== "string" || customCwd.length === 0)) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(formatResponse.toolError("Invalid cwd parameter: cwd must be a non-empty string."))
				return
			}

			if (
				timeoutSeconds !== undefined &&
				timeoutSeconds !== null &&
				(typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds))
			) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(
					formatResponse.toolError("Invalid timeout parameter: timeout must be a finite number or null."),
				)
				return
			}

			const canonicalCommand = unescapeHtmlEntities(command)

			const ignoredFileAttemptedToAccess = task.rooIgnoreController?.validateCommand(canonicalCommand)

			if (ignoredFileAttemptedToAccess) {
				await task.say("rooignore_error", ignoredFileAttemptedToAccess)
				pushToolResult(formatResponse.rooIgnoreError(ignoredFileAttemptedToAccess))
				return
			}

			task.consecutiveMistakeCount = 0

			// Detect shell syntax errors (unterminated quotes, unclosed heredocs) before
			// presenting the command for approval. Surfacing this as a tool error gives
			// the agent a precise, actionable message so it can retry with a corrected
			// command, rather than receiving a generic denial from the approval dialog.
			const { parseError } = parseCommand(canonicalCommand)
			if (parseError !== null) {
				const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
				const provider = await task.providerRef.deref()
				const errorStatus: CommandExecutionStatus = {
					executionId,
					status: "error",
					message: parseError.message,
				}
				provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(errorStatus) })
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(parseError.message))
				return
			}

			const didApprove = await askApproval("command", canonicalCommand)

			if (!didApprove) {
				return
			}

			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			const provider = await task.providerRef.deref()
			const providerState = await provider?.getState()

			const { terminalShellIntegrationDisabled = true } = providerState ?? {}

			// Resolve the command environment snapshot for this request.
			// This is the same snapshot used by the system prompt and tool description.
			// When available, it provides the primary and fallback invocation plans.
			const resolvedEnv = task.getResolvedCommandEnvironment()

			// Get command execution timeout from VSCode configuration (in seconds)
			const commandExecutionTimeoutSeconds = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("commandExecutionTimeout", 0)

			// Get command timeout allowlist from VSCode configuration
			const commandTimeoutAllowlist = vscode.workspace
				.getConfiguration(Package.name)
				.get<string[]>("commandTimeoutAllowlist", [])

			// Check if command matches any prefix in the allowlist
			const isCommandAllowlisted = commandTimeoutAllowlist.some((prefix) =>
				canonicalCommand.startsWith(prefix.trim()),
			)

			// Convert seconds to milliseconds for internal use, but skip timeout if command is allowlisted
			const commandExecutionTimeout = isCommandAllowlisted ? 0 : commandExecutionTimeoutSeconds * 1000

			// Convert agent-specified timeout from seconds to milliseconds
			const agentTimeout = resolveAgentTimeoutMs(timeoutSeconds)

			// Observability trace builder — one instance across initial attempt,
			// same-terminal recovery, and provider fallback.
			const traceBuilder = new CommandTraceBuilder({
				executionId,
				taskId: task.taskId,
				modelId: getModelId(task.apiConfiguration),
				commandLength: canonicalCommand.length,
				commandCountInChain: 1,
			})
			traceBuilder.markToolCallGeneratedAt(Date.now())

			const options: ExecuteCommandOptions = {
				executionId,
				command: canonicalCommand,
				customCwd,
				terminalShellIntegrationDisabled,
				commandExecutionTimeout,
				agentTimeout,
				resolvedEnv,
				traceBuilder,
			}

			const scheduler = CommandScheduler.getInstance()
			const queuedStatus: CommandExecutionStatus = { executionId, status: "queued" }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(queuedStatus) })

			const queueEnteredAt = Date.now()
			traceBuilder.markQueueEnteredAt(queueEnteredAt)
			await scheduler.enqueue({ executionId, taskId: task.taskId, requestedAt: queueEnteredAt })
			const queueReleasedAt = Date.now()
			traceBuilder.markQueueReleasedAt(queueReleasedAt)
			traceBuilder.markQueueWaitMs(queueReleasedAt - queueEnteredAt)

			try {
				const [rejected, result] = await executeCommandInTerminal(task, options)

				if (rejected) {
					task.didRejectTool = true
				}

				pushToolResult(result)
			} catch (error: unknown) {
				// Invalidate pending ask from first execution to prevent race condition
				task.supersedePendingAsk()

				if (error instanceof TerminalExecutionError) {
					// Safe fallback orchestration: pre-submit failures can switch to the
					// same-family Execa fallback after cleaning up the source terminal.
					if (error.retryDisposition === "fallback-safe" && !error.commandSubmitted) {
						const terminalId = typeof error.terminalId === "number" ? error.terminalId : undefined

						const fallbackStatus: CommandExecutionStatus = {
							executionId,
							status: "fallback",
							reasonCode: error.code,
						}
						provider?.postMessageToWebview({
							type: "commandExecutionStatus",
							text: JSON.stringify(fallbackStatus),
						})

						let fallbackTerminal: RooTerminal | undefined

						if (terminalId !== undefined && resolvedEnv) {
							try {
								fallbackTerminal = (
									await TerminalRegistry.prepareProviderSwitch({
										terminalId,
										executionId,
										fromProvider: "vscode",
										toProvider: "execa",
										reasonCode: error.code,
										commandSubmitted: error.commandSubmitted,
										resolvedEnv,
									})
								).terminal
							} catch (switchError) {
								await handleError("executing command", switchError as Error)
								return
							}
						}

						try {
							const [rejected, result] = await executeCommandInTerminal(task, {
								...options,
								terminalShellIntegrationDisabled: true,
								useFallbackPlan: !!resolvedEnv,
								reuseTerminal: fallbackTerminal,
							})

							if (rejected) {
								task.didRejectTool = true
							}

							pushToolResult(
								`[Note: VS Code's terminal shell integration was temporarily unavailable — this is a known VS Code infrastructure issue and does not affect command results. The command was automatically retried and completed successfully.]\n\n${result}`,
							)
						} catch (fallbackError) {
							await handleError("executing command", fallbackError as Error)
						}

						return
					}

					// No-replay policy: post-submit or otherwise unknown outcomes must not
					// run the command a second time.
					if (error.retryDisposition === "never") {
						const errorStatus: CommandExecutionStatus = {
							executionId,
							status: "error",
							code: error.code,
						}
						provider?.postMessageToWebview({
							type: "commandExecutionStatus",
							text: JSON.stringify(errorStatus),
						})
						pushToolResult(
							formatResponse.toolError(
								`Command failed to execute in terminal due to a shell integration error (${error.code}).`,
							),
						)
						return
					}
				}

				// Unknown terminal error
				await handleError("executing command", error as Error)
			} finally {
				scheduler.release(executionId)
				// Ensure the trace is emitted exactly once even when the command
				// throws before reaching the normal completion path in
				// executeCommandInTerminal.
				traceBuilder.finalize()
			}

			return
		} catch (error) {
			await handleError("executing command", error as Error)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"execute_command">): Promise<void> {
		const command = block.params.command
		await task.ask("command", command ?? "", block.partial).catch(() => {})
	}
}

export type ExecuteCommandOptions = {
	executionId: string
	command: string
	customCwd?: string
	terminalShellIntegrationDisabled?: boolean
	commandExecutionTimeout?: number
	agentTimeout?: number
	/** Resolved command environment snapshot from CommandEnvironmentService. */
	resolvedEnv?: ResolvedCommandEnvironment
	/** When true, use the fallback plan instead of the primary plan (retry path). */
	useFallbackPlan?: boolean
	/** Optional terminal to reuse instead of acquiring a new one. Used by recovery and fallback. */
	reuseTerminal?: RooTerminal
	/** When true, a same-terminal recovery has already been attempted. */
	recoveryAttempted?: boolean
	/**
	 * Optional trace builder for observability. When provided, the function
	 * records terminal lifecycle timestamps and emits a final trace at completion.
	 */
	traceBuilder?: CommandTraceBuilder
}

export async function executeCommandInTerminal(
	task: Task,
	options: ExecuteCommandOptions,
): Promise<[boolean, ToolResponse]> {
	const {
		executionId,
		command,
		customCwd,
		terminalShellIntegrationDisabled = true,
		commandExecutionTimeout = 0,
		agentTimeout = 0,
		resolvedEnv,
		useFallbackPlan = false,
		reuseTerminal,
		recoveryAttempted = false,
		traceBuilder,
	} = options
	// Convert milliseconds back to seconds for display purposes.
	const commandExecutionTimeoutSeconds = commandExecutionTimeout / 1000
	let workingDir: string

	// Defense-in-depth: ensure customCwd is a string before passing to path APIs
	if (customCwd !== undefined && (typeof customCwd !== "string" || customCwd.length === 0)) {
		return [false, formatResponse.toolError("Invalid cwd parameter: cwd must be a non-empty string.")]
	}

	if (!customCwd) {
		workingDir = task.cwd
	} else if (path.isAbsolute(customCwd)) {
		workingDir = customCwd
	} else {
		workingDir = path.resolve(task.cwd, customCwd)
	}

	let traceFinalized = false
	const finalizeTrace = () => {
		if (traceFinalized || !traceBuilder) {
			return
		}
		traceFinalized = true
		traceBuilder.finalize()
	}

	try {
		await fs.access(workingDir)
	} catch (error) {
		traceBuilder?.markError("WORKING_DIR_NOT_FOUND")
		finalizeTrace()
		return [false, `Working directory '${workingDir}' does not exist.`]
	}

	let message: { text?: string; images?: string[] } | undefined
	let runInBackground = false
	let completed = false
	let result: string = ""
	let persistedResult: PersistedCommandOutput | undefined
	let exitDetails: ExitCodeDetails | undefined
	let shellIntegrationError: ShellIntegrationError | undefined
	let hasAskedForCommandOutput = false

	// Determine the terminal provider. When a resolved environment is available,
	// the provider comes from the primary plan — this is the single source of truth
	// that matches the system prompt and tool description shown to the model.
	const { terminalProvider, isCmdExeFallback } = getTerminalProviderForExecution(
		terminalShellIntegrationDisabled,
		resolvedEnv,
	)
	const provider = await task.providerRef.deref()

	// cmd.exe can't use shell integration — tell the webview to expand the output
	// panel immediately (same effect as the retry-fallback path).
	if (isCmdExeFallback) {
		const status: CommandExecutionStatus = { executionId, status: "fallback" }
		provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
	}

	// Get global storage path for persisted output artifacts
	const globalStoragePath = provider?.context?.globalStorageUri?.fsPath
	let interceptor: OutputInterceptor | undefined

	// Create OutputInterceptor if we have storage available
	if (globalStoragePath) {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, task.taskId)
		const storageDir = path.join(taskDir, "command-output")
		const providerState = await provider?.getState()
		const terminalOutputPreviewSize =
			providerState?.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE

		interceptor = new OutputInterceptor({
			executionId,
			taskId: task.taskId,
			command,
			storageDir,
			previewSize: terminalOutputPreviewSize,
		})
	}

	let accumulatedOutput = ""
	// Bound accumulated output buffer size to prevent unbounded memory growth for long-running commands.
	// The interceptor preserves full output; this buffer is only for UI display (100KB limit).
	const maxAccumulatedOutputSize = 100_000
	const commandOutputStreamThrottleMs = 150
	let latestCompressedOutput = ""
	let lastQueuedCommandOutput = ""
	let lastCommandOutputEmitAt = 0
	let pendingCommandOutputEmitTimer: NodeJS.Timeout | undefined
	let commandOutputSayChain: Promise<void> = Promise.resolve()

	const queueCommandOutputMessage = (text: string, partial: boolean, force = false): Promise<void> => {
		if (!force && text === lastQueuedCommandOutput) {
			return commandOutputSayChain
		}

		lastQueuedCommandOutput = text
		commandOutputSayChain = commandOutputSayChain
			.then(async () => {
				await task.say("command_output", text, undefined, partial, undefined, undefined, {
					isNonInteractive: true,
				})
			})
			// Best-effort: output publishing failures should not crash the command. Logging only.
			.catch((error) => {
				console.error("[ExecuteCommandTool] Failed to publish command output:", error)
			})

		return commandOutputSayChain
	}

	const schedulePartialCommandOutputUpdate = () => {
		if (!latestCompressedOutput || completed) {
			return
		}

		const emitUpdate = () => {
			pendingCommandOutputEmitTimer = undefined
			lastCommandOutputEmitAt = Date.now()
			void queueCommandOutputMessage(latestCompressedOutput, true)
		}

		const elapsed = Date.now() - lastCommandOutputEmitAt
		if (elapsed >= commandOutputStreamThrottleMs) {
			emitUpdate()
			return
		}

		if (!pendingCommandOutputEmitTimer) {
			pendingCommandOutputEmitTimer = setTimeout(emitUpdate, commandOutputStreamThrottleMs - elapsed)
		}
	}

	// Track when onCompleted callback finishes to avoid race condition.
	// The callback is async but Terminal/ExecaTerminal don't await it, so we track completion
	// explicitly to ensure persistedResult is set before we use it.
	let resolveOnCompleted: (() => void) | undefined
	const onCompletedPromise = new Promise<void>((resolve) => {
		resolveOnCompleted = resolve
	})

	// Delay the `command_output` ask so short foreground commands that emit
	// output and exit normally never prompt the user. The ask only fires if the
	// command is still running once COMMAND_OUTPUT_ASK_DELAY_MS has elapsed
	// since execution started, preserving the interrupt/feedback path for
	// long-running commands. The anchor is re-based to onShellExecutionStarted
	// (falling back to the pre-runCommand timestamp when that event never
	// fires) so shell-integration startup on cold terminals does not consume
	// the grace period.
	let commandStartedAt = 0
	let commandOutputAskTimer: NodeJS.Timeout | undefined

	const askForCommandOutput = async (process: RooTerminalProcess): Promise<void> => {
		if (runInBackground || hasAskedForCommandOutput || completed) {
			return
		}

		// Mark that we've asked to prevent multiple concurrent asks
		hasAskedForCommandOutput = true

		try {
			const { response, text, images } = await task.ask("command_output", "")
			runInBackground = true

			if (response === "messageResponse") {
				message = { text, images }
			}

			// Any answer means the command should keep running in the background;
			// continue the process so the tool resolves now instead of blocking
			// until the command actually completes.
			process.continue()
		} catch (_error) {
			// Silently handle ask errors (e.g., "Current ask promise was ignored")
		}
	}

	const scheduleCommandOutputAsk = (process: RooTerminalProcess): void => {
		if (runInBackground || hasAskedForCommandOutput || completed || commandOutputAskTimer) {
			return
		}

		const remainingDelay = COMMAND_OUTPUT_ASK_DELAY_MS - (Date.now() - commandStartedAt)

		commandOutputAskTimer = setTimeout(
			() => {
				commandOutputAskTimer = undefined
				void askForCommandOutput(process)
			},
			Math.max(remainingDelay, 0),
		)
	}

	const callbacks: RooTerminalCallbacks = {
		onLine: async (lines: string, process: RooTerminalProcess) => {
			traceBuilder?.markFirstOutputAt(Date.now())
			accumulatedOutput += lines

			// Trim accumulated output to prevent unbounded memory growth
			if (accumulatedOutput.length > maxAccumulatedOutputSize) {
				accumulatedOutput = accumulatedOutput.slice(-maxAccumulatedOutputSize)
			}

			// Write to interceptor for persisted output
			interceptor?.write(lines)

			// Continue sending compressed output to webview for UI display (unchanged behavior)
			const compressedOutput = Terminal.compressTerminalOutput(accumulatedOutput)
			latestCompressedOutput = compressedOutput
			const status: CommandExecutionStatus = { executionId, status: "output", output: compressedOutput }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			schedulePartialCommandOutputUpdate()

			scheduleCommandOutputAsk(process)
		},
		onCompleted: async (output: string | undefined) => {
			clearTimeout(commandOutputAskTimer)
			commandOutputAskTimer = undefined

			// If an interactive command_output ask is still pending, supersede it
			// so it resolves immediately instead of lingering until the next
			// interactive message bumps lastMessageTs.
			if (hasAskedForCommandOutput && !runInBackground) {
				task.supersedePendingAsk()
			}

			clearTimeout(pendingCommandOutputEmitTimer)
			pendingCommandOutputEmitTimer = undefined

			try {
				// Finalize interceptor and get persisted result.
				// We await finalize() to ensure the artifact file is fully flushed
				// before we advertise the artifact_id to the LLM.
				if (interceptor) {
					persistedResult = await interceptor.finalize()
				}
			} catch (error) {
				// Best-effort: output publishing failures should not crash the command. Logging only.
				console.error("[ExecuteCommandTool] interceptor.finalize() failed:", error)
			}

			// Continue using compressed output for UI display
			result = Terminal.compressTerminalOutput(output ?? "")
			latestCompressedOutput = result
			completed = true

			// Unblock the main code path: persistedResult, result, and completed are
			// all set now. Resolve before draining the UI say chain so that a stalled
			// or slow webview update cannot prevent the tool result from being returned.
			resolveOnCompleted?.()

			// Preserve order: wait for queued partial updates, then emit the final
			// non-partial command_output update. Fire-and-forget from the main path —
			// errors here are UI-only and must not surface to the tool result.
			commandOutputSayChain
				.then(() => queueCommandOutputMessage(result, false, true))
				// Best-effort: output publishing failures should not crash the command. Logging only.
				.catch((error) => {
					console.error("[ExecuteCommandTool] Failed to flush final command_output:", error)
				})
		},
		onShellExecutionStarted: (pid: number | undefined, process: RooTerminalProcess) => {
			const now = Date.now()
			traceBuilder?.markProcessIdResolvedAt(now)
			traceBuilder?.markShellExecutionStartedAt(now)
			const status: CommandExecutionStatus = { executionId, status: "started", pid, command }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })

			// Re-anchor the ask delay to actual execution start so the shell
			// integration startup wait does not count against the grace period.
			commandStartedAt = Date.now()

			// Output should not precede this event, but if it did, reschedule
			// the pending ask against the corrected anchor.
			if (commandOutputAskTimer) {
				clearTimeout(commandOutputAskTimer)
				commandOutputAskTimer = undefined
				scheduleCommandOutputAsk(process)
			}
		},
		onShellExecutionComplete: (details: ExitCodeDetails) => {
			traceBuilder?.markShellExecutionEndedAt(Date.now(), details.exitCode ?? undefined)
			const status: CommandExecutionStatus = { executionId, status: "exited", exitCode: details.exitCode }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			exitDetails = details
		},
	}

	if (terminalProvider === "vscode") {
		callbacks.onNoShellIntegration = async (details: ShellIntegrationErrorDetails) => {
			traceBuilder?.markShellIntegrationTimeoutAt(Date.now())
			traceBuilder?.markError(details.code ?? "SI_ACTIVATION_TIMEOUT")
			TelemetryService.instance.captureShellIntegrationError(task.taskId)
			shellIntegrationError = new ShellIntegrationError(details.message, details.commandSubmitted)
		}
	}

	// When a resolved environment is available, set the shell family for
	// terminal reuse keying so that changing shells prevents reuse of terminals
	// created with a different family.
	if (!reuseTerminal && resolvedEnv) {
		TerminalRegistry.setExecaShellFamily(resolvedEnv.primaryPlan.family)
	}

	traceBuilder?.markTerminalRequestedAt(Date.now())
	const terminal =
		reuseTerminal ??
		(await TerminalRegistry.getOrCreateTerminal(
			workingDir,
			task.taskId,
			executionId,
			terminalProvider,
			resolvedEnv,
		))

	const terminalAcquiredAt = Date.now()
	const terminalReused = reuseTerminal !== undefined || terminal.lifecycle.state !== "creating"
	traceBuilder?.markTerminalCreatedAt(terminalAcquiredAt, terminalReused, terminal.lifecycle.state)
	traceBuilder?.markProvider(terminal.provider)
	traceBuilder?.markShellIntegrationInitiallyAvailable(
		terminal.provider === "vscode" && terminal instanceof Terminal
			? terminal.terminal.shellIntegration !== undefined
			: false,
	)
	traceBuilder?.markConcurrentCommandCount(1)
	traceBuilder?.markConcurrentTerminalCreationCount(terminalReused ? 0 : 1)

	if (terminal instanceof Terminal) {
		terminal.terminal.show(true)

		// Update the working directory in case the terminal we asked for has
		// a different working directory so that the model will know where the
		// command actually executed.
		workingDir = terminal.getCurrentWorkingDirectory()
	}

	// When using execa with a resolved environment, set the shell invocation
	// plan so ExecaTerminalProcess uses the family-specific adapter instead of
	// the legacy `shell: true` path. On the retry path, use the fallback plan.
	if (terminal instanceof ExecaTerminal && resolvedEnv) {
		const plan: ShellInvocationPlan | undefined = useFallbackPlan
			? resolvedEnv.fallbackPlan
			: resolvedEnv.primaryPlan
		if (plan) {
			terminal.setShellInvocationPlan(plan)
		}
	}

	// Fallback anchor for providers that never fire onShellExecutionStarted.
	commandStartedAt = Date.now()

	traceBuilder?.markCommandSubmittedAt(Date.now())
	const process = terminal.runCommand(command, callbacks, executionId)
	task.terminalProcess = process

	// Dual-timeout logic:
	// - Agent timeout: transitions the command to background (continues running)
	// - User timeout: aborts the command (kills it)
	// Both timers run independently — the user timeout remains active as a safety net
	// even after the agent timeout moves the command to the background.
	let agentTimeoutId: NodeJS.Timeout | undefined
	let userTimeoutId: NodeJS.Timeout | undefined
	let isUserTimedOut = false

	try {
		const racers: Promise<void>[] = [process]

		// Agent timeout: transition to background (command keeps running)
		if (agentTimeout > 0) {
			racers.push(
				new Promise<void>((resolve) => {
					agentTimeoutId = setTimeout(() => {
						runInBackground = true
						clearTimeout(commandOutputAskTimer)
						commandOutputAskTimer = undefined
						process.continue()
						task.supersedePendingAsk()
						resolve()
					}, agentTimeout)
				}),
			)
		}

		// User timeout: abort the command (existing behavior)
		if (commandExecutionTimeout > 0) {
			racers.push(
				new Promise<void>((_, reject) => {
					userTimeoutId = setTimeout(() => {
						isUserTimedOut = true
						task.terminalProcess?.abort()
						reject(new Error(`Command execution timed out after ${commandExecutionTimeout}ms`))
					}, commandExecutionTimeout)
				}),
			)
		}

		await Promise.race(racers)
	} catch (error) {
		if (isUserTimedOut) {
			traceBuilder?.markError("USER_TIMEOUT")
			const status: CommandExecutionStatus = { executionId, status: "timeout" }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			await task.say("error", t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }))
			task.didToolFailInCurrentTurn = true
			task.terminalProcess = undefined

			finalizeTrace()
			return [
				false,
				`The command was terminated after exceeding a user-configured ${commandExecutionTimeoutSeconds}s timeout. Do not try to re-run the command.`,
			]
		}
		throw error
	} finally {
		clearTimeout(agentTimeoutId)
		clearTimeout(userTimeoutId)
		clearTimeout(commandOutputAskTimer)
		clearTimeout(pendingCommandOutputEmitTimer)
		task.terminalProcess = undefined
	}

	if (shellIntegrationError) {
		const error = shellIntegrationError

		// One same-terminal recovery attempt for pre-submit SI activation timeout.
		// The recovery never submits the command until shell integration is confirmed.
		if (
			!recoveryAttempted &&
			error.retryDisposition === "same-terminal-once" &&
			!error.commandSubmitted &&
			terminal instanceof Terminal
		) {
			try {
				terminal.lifecycle.incrementRecovery()
			} catch {
				terminal.lifecycle.markBroken()
				terminal.terminal.dispose()
				throw new ShellIntegrationError(
					"Recovery limit exceeded for shell integration timeout",
					false,
					"SI_ACTIVATION_TIMEOUT",
					{
						terminalId: terminal.id,
						retryDisposition: "fallback-safe",
					},
				)
			}

			const recoveringStatus: CommandExecutionStatus = {
				executionId,
				status: "recovering",
				errorCode: error.code,
			}
			provider?.postMessageToWebview({
				type: "commandExecutionStatus",
				text: JSON.stringify(recoveringStatus),
			})

			if (!terminal.isClosed()) {
				await delay(400)

				if (!terminal.isClosed()) {
					try {
						terminal.lifecycle.transition("failed", executionId)
						return await executeCommandInTerminal(task, {
							...options,
							reuseTerminal: terminal,
							recoveryAttempted: true,
						})
					} catch (retryError) {
						traceBuilder?.markError(
							retryError instanceof TerminalExecutionError ? retryError.code : "RECOVERY_FAILED",
						)
						if (retryError instanceof TerminalExecutionError) {
							throw new ShellIntegrationError(
								`Shell integration recovery failed: ${retryError.message}`,
								retryError.commandSubmitted,
								retryError.code as TerminalErrorCode,
								{
									phase: retryError.phase,
									provider: retryError.provider,
									terminalId: terminal.id,
									outcome: retryError.outcome,
									retryDisposition: "fallback-safe",
									causeName: retryError.causeName,
								},
							)
						}
						throw retryError
					}
				}
			}

			// Recovery not possible: quarantine the terminal and request a provider switch.
			terminal.lifecycle.markBroken()
			terminal.terminal.dispose()
			throw new ShellIntegrationError(
				"Shell integration not available after recovery attempt",
				false,
				"SI_ACTIVATION_TIMEOUT",
				{
					terminalId: terminal.id,
					retryDisposition: "fallback-safe",
				},
			)
		}

		// If recovery is not applicable or already exhausted, convert a pre-submit
		// same-terminal-once error into a fallback-safe request so the caller can
		// switch provider instead of leaving the command unexecuted.
		if (error.retryDisposition === "same-terminal-once" && !error.commandSubmitted) {
			throw new ShellIntegrationError("Shell integration recovery not possible", false, error.code, {
				terminalId: terminal.id,
				retryDisposition: "fallback-safe",
			})
		}

		throw error
	}

	// Wait for a short delay to ensure all messages are sent to the webview.
	// This delay allows time for non-awaited promises to be created and
	// for their associated messages to be sent to the webview, maintaining
	// the correct order of messages (although the webview is smart about
	// grouping command_output messages despite any gaps anyways).
	await delay(50)

	// Wait for onCompleted callback to finish. onCompleted is async and sets
	// `completed` and `persistedResult`; we must not read them until it resolves.
	// Skip when returning a background result: the command is still running and
	// onCompleted will fire later — awaiting it here would block until real completion,
	// defeating the purpose of the agent-timeout background transition.
	if (!runInBackground) {
		await onCompletedPromise
	}

	if (message) {
		const { text, images } = message
		await task.say("user_feedback", text, images)

		finalizeTrace()
		return [
			true,
			formatResponse.toolResult(
				[
					`Command is still running in terminal from '${terminal.getCurrentWorkingDirectory().toPosix()}'.`,
					result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
					`<user_message>\n${text}\n</user_message>`,
				].join("\n"),
				images,
			),
		]
	} else if (completed || exitDetails) {
		const currentWorkingDir = terminal.getCurrentWorkingDirectory().toPosix()

		// Use persisted output format when output was truncated and spilled to disk
		if (persistedResult?.truncated) {
			finalizeTrace()
			return [false, formatPersistedOutput(persistedResult, exitDetails, currentWorkingDir)]
		}

		// Use inline format for small outputs (original behavior with exit status).
		if (exitDetails === undefined) {
			result += "<VSCE exitDetails == undefined: terminal output and command execution status is unknown.>"
		} else if (!exitDetails.signalName && exitDetails.exitCode === undefined) {
			result += "<VSCE exit code is undefined: terminal output and command execution status is unknown.>"
		}

		const exitStatus = formatExitStatus(exitDetails)

		finalizeTrace()
		return [
			false,
			`Command executed in terminal within working directory '${currentWorkingDir}'. ${exitStatus}\nOutput:\n${result}`,
		]
	} else {
		finalizeTrace()
		return [
			false,
			[
				`Command is still running in terminal ${workingDir ? ` from '${workingDir.toPosix()}'` : ""}.`,
				result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
				"You will be updated on the terminal status and new output in the future.",
			].join("\n"),
		]
	}
}

/**
 * Format exit status from ExitCodeDetails
 */
function formatExitStatus(exitDetails: ExitCodeDetails | undefined): string {
	if (exitDetails === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	if (exitDetails.signalName) {
		let status = `Process terminated by signal ${exitDetails.signalName}`
		if (exitDetails.coreDumpPossible) {
			status += " - core dump possible"
		}
		return status
	}

	if (exitDetails.exitCode === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	let status = ""
	if (exitDetails.exitCode !== 0) {
		status += "Command execution was not successful, inspect the cause and adjust as needed.\n"
	}
	status += `Exit code: ${exitDetails.exitCode}`
	return status
}

/**
 * Format persisted output result for tool response when output was truncated
 */
function formatPersistedOutput(
	result: PersistedCommandOutput,
	exitDetails: ExitCodeDetails | undefined,
	workingDir: string,
): string {
	const exitStatus = formatExitStatus(exitDetails)
	const sizeStr = formatBytes(result.totalBytes)
	const artifactId = result.artifactPath ? path.basename(result.artifactPath) : ""

	return [
		`Command executed in '${workingDir}'. ${exitStatus}`,
		"",
		`Output (${sizeStr}) persisted. Artifact ID: ${artifactId}`,
		"",
		"Preview:",
		result.preview,
		"",
		"Use read_command_output tool to view full output if needed.",
	].join("\n")
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const executeCommandTool = new ExecuteCommandTool()
