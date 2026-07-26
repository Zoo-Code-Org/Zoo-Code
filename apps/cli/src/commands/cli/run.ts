import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import { createElement } from "react"
import pWaitFor from "p-wait-for"

import { setLogger } from "@roo-code/vscode-shim"

import {
	FlagOptions,
	isSupportedProvider,
	supportedProviders,
	DEFAULT_FLAGS,
	REASONING_EFFORTS,
	OutputFormat,
} from "@/types/index.js"
import { isValidOutputFormat } from "@/types/json-events.js"
import { JsonEventEmitter } from "@/agent/json-event-emitter.js"

import { loadSettings } from "@/lib/storage/index.js"
import { readWorkspaceTaskSessions, resolveWorkspaceResumeSessionId } from "@/lib/task-history/index.js"
import { getEnvVarName, getApiKeyFromEnv } from "@/lib/utils/provider.js"
import { validateTerminalShellPath } from "@/lib/utils/shell.js"
import { getDefaultExtensionPath } from "@/lib/utils/extension.js"
import { isValidSessionId } from "@/lib/utils/session-id.js"
import { runOnboarding } from "@/lib/utils/onboarding.js"
import { VERSION } from "@/lib/utils/version.js"

import { ExtensionHost, ExtensionHostOptions } from "@/agent/index.js"
import { AUTONOMOUS_EXIT_CODES, AutonomousRunError, type AutonomousTerminalState } from "@/agent/autonomous-run.js"
import { isExpectedControlFlowError } from "./cancellation.js"
import { runStdinStreamMode } from "./stdin-stream.js"
import { validateAutonomousFlags, validateProviderBaseUrl } from "./autonomous-validation.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SIGNAL_ONLY_EXIT_KEEPALIVE_MS = 60_000
const STREAM_RESUME_WAIT_TIMEOUT_MS = 2_000

async function bootstrapResumeForStdinStream(host: ExtensionHost, sessionId: string): Promise<void> {
	host.sendToExtension({ type: "showTaskWithId", text: sessionId })

	// Best-effort wait so early stdin "message" commands can target the resumed task.
	await pWaitFor(() => host.client.hasActiveTask() || host.isWaitingForInput(), {
		interval: 25,
		timeout: STREAM_RESUME_WAIT_TIMEOUT_MS,
	}).catch(() => undefined)
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

export async function run(promptArg: string | undefined, flagOptions: FlagOptions) {
	setLogger({
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	})

	let prompt = promptArg
	const autonomous = flagOptions.autonomous
	const requestedOutputFormat: OutputFormat = (flagOptions.outputFormat as OutputFormat) || "text"

	const failConfiguration = (message: string): never => {
		if (autonomous && requestedOutputFormat !== "text") {
			process.stdout.write(
				JSON.stringify({
					type: "result",
					subtype: "terminal",
					done: true,
					success: false,
					state: "configuration_error",
					exitCode: AUTONOMOUS_EXIT_CODES.configuration_error,
					content: message,
					resumable: false,
				}) + "\n",
			)
		} else {
			console.error(`[CLI] Error: ${message}`)
		}
		process.exit(autonomous ? AUTONOMOUS_EXIT_CODES.configuration_error : 1)
	}
	const exitValidation = (message: string): never => {
		if (autonomous) failConfiguration(message)
		process.exit(1)
	}

	if (flagOptions.promptFile) {
		if (!fs.existsSync(flagOptions.promptFile)) {
			console.error(`[CLI] Error: Prompt file does not exist: ${flagOptions.promptFile}`)
			exitValidation(`Prompt file does not exist: ${flagOptions.promptFile}`)
		}

		prompt = fs.readFileSync(flagOptions.promptFile, "utf-8")
	}

	const requestedSessionId = flagOptions.sessionId?.trim()
	const requestedCreateSessionId = flagOptions.createWithSessionId?.trim()
	const shouldContinueSession = flagOptions.continue
	const isResumeRequested = Boolean(requestedSessionId || shouldContinueSession)

	if (flagOptions.createWithSessionId !== undefined && !requestedCreateSessionId) {
		console.error("[CLI] Error: --create-with-session-id requires a non-empty session id")
		exitValidation("--create-with-session-id requires a non-empty session id")
	}

	if (flagOptions.sessionId !== undefined && !requestedSessionId) {
		console.error("[CLI] Error: --session-id requires a non-empty session id")
		exitValidation("--session-id requires a non-empty session id")
	}

	if (requestedCreateSessionId && !isValidSessionId(requestedCreateSessionId)) {
		console.error("[CLI] Error: --create-with-session-id must be a valid UUID session id")
		exitValidation("--create-with-session-id must be a valid UUID session id")
	}

	if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
		console.error("[CLI] Error: --session-id must be a valid UUID session id")
		exitValidation("--session-id must be a valid UUID session id")
	}

	if (requestedCreateSessionId && isResumeRequested) {
		console.error("[CLI] Error: cannot use --create-with-session-id with --session-id/--continue")
		exitValidation("cannot use --create-with-session-id with --session-id/--continue")
	}

	if (requestedSessionId && shouldContinueSession) {
		console.error("[CLI] Error: cannot use --session-id with --continue")
		exitValidation("cannot use --session-id with --continue")
	}

	if (isResumeRequested && prompt) {
		console.error("[CLI] Error: cannot use prompt or --prompt-file with --session-id/--continue")
		console.error("[CLI] Usage: roo [--session-id <session-id> | --continue] [options]")
		exitValidation("cannot use prompt or --prompt-file with --session-id/--continue")
	}

	// Options

	const settings = await loadSettings()

	const isTuiSupported = process.stdin.isTTY && process.stdout.isTTY
	const isTuiEnabled = !flagOptions.print && isTuiSupported
	const isOnboardingEnabled = isTuiEnabled && !flagOptions.provider && !settings.provider

	// Determine effective values: CLI flags > settings file > DEFAULT_FLAGS.
	const autonomousValidationErrors = validateAutonomousFlags({
		autonomous,
		mode: flagOptions.mode,
		requireApproval: flagOptions.requireApproval,
		print: flagOptions.print,
		stdinPromptStream: flagOptions.stdinPromptStream,
		workspace: flagOptions.workspace,
		timeout: flagOptions.timeout,
		providerBaseUrl: flagOptions.providerBaseUrl,
		provider: flagOptions.provider ?? settings.provider ?? "openrouter",
	})
	if (autonomousValidationErrors.length > 0) {
		failConfiguration(autonomousValidationErrors[0].message)
	}

	const effectiveMode = autonomous ? "orchestrator" : flagOptions.mode || settings.mode || DEFAULT_FLAGS.mode
	const effectiveModel = flagOptions.model || settings.model || DEFAULT_FLAGS.model
	const effectiveReasoningEffort =
		flagOptions.reasoningEffort || settings.reasoningEffort || DEFAULT_FLAGS.reasoningEffort
	const effectiveProvider = flagOptions.provider ?? settings.provider ?? "openrouter"
	let effectiveWorkspacePath = flagOptions.workspace ? path.resolve(flagOptions.workspace) : process.cwd()
	if (autonomous) {
		try {
			effectiveWorkspacePath = fs.realpathSync(effectiveWorkspacePath)
			if (!fs.statSync(effectiveWorkspacePath).isDirectory()) {
				failConfiguration(`Workspace path is not a directory: ${effectiveWorkspacePath}`)
			}
		} catch {
			failConfiguration(`Workspace path does not exist or cannot be resolved: ${effectiveWorkspacePath}`)
		}
	}
	const legacyRequireApprovalFromSettings =
		settings.requireApproval ??
		(settings.dangerouslySkipPermissions === undefined ? undefined : !settings.dangerouslySkipPermissions)
	const effectiveRequireApproval = autonomous
		? false
		: flagOptions.requireApproval || legacyRequireApprovalFromSettings || false
	const effectiveExitOnComplete = autonomous || flagOptions.print || flagOptions.oneshot || settings.oneshot || false
	const rawConsecutiveMistakeLimit =
		flagOptions.consecutiveMistakeLimit ?? settings.consecutiveMistakeLimit ?? DEFAULT_FLAGS.consecutiveMistakeLimit
	const effectiveConsecutiveMistakeLimit = Number(rawConsecutiveMistakeLimit)

	if (!isSupportedProvider(effectiveProvider)) {
		console.error(
			`[CLI] Error: Invalid provider: ${effectiveProvider}; must be one of: ${supportedProviders.join(", ")}`,
		)
		exitValidation(`Invalid provider: ${effectiveProvider}`)
	}
	// Note: providerBaseUrl validation is already handled in autonomousValidationErrors for autonomous mode,
	// but we need to check it for non-autonomous mode as well
	if (!autonomous) {
		const providerBaseUrlError = validateProviderBaseUrl(flagOptions.providerBaseUrl, effectiveProvider)
		if (providerBaseUrlError) {
			failConfiguration(providerBaseUrlError.message)
		}
	}

	if (!Number.isInteger(effectiveConsecutiveMistakeLimit) || effectiveConsecutiveMistakeLimit < 0) {
		console.error(
			`[CLI] Error: Invalid consecutive mistake limit: ${rawConsecutiveMistakeLimit}; must be a non-negative integer`,
		)
		exitValidation(`Invalid consecutive mistake limit: ${rawConsecutiveMistakeLimit}`)
	}

	let terminalShell: string | undefined
	if (flagOptions.terminalShell !== undefined) {
		const validatedTerminalShell = await validateTerminalShellPath(flagOptions.terminalShell)

		if (!validatedTerminalShell.valid) {
			console.error(
				`[CLI] Warning: ignoring --terminal-shell "${flagOptions.terminalShell}" (${validatedTerminalShell.reason})`,
			)
		} else {
			terminalShell = validatedTerminalShell.shellPath
		}
	}

	const extensionHostOptions: ExtensionHostOptions = {
		mode: effectiveMode,
		reasoningEffort: effectiveReasoningEffort === "unspecified" ? undefined : effectiveReasoningEffort,
		consecutiveMistakeLimit: effectiveConsecutiveMistakeLimit,
		user: null,
		provider: effectiveProvider,
		model: effectiveModel,
		workspacePath: effectiveWorkspacePath,
		extensionPath: path.resolve(flagOptions.extension || getDefaultExtensionPath(__dirname)),
		nonInteractive: !effectiveRequireApproval,
		exitOnError: flagOptions.exitOnError,
		ephemeral: flagOptions.ephemeral,
		debug: flagOptions.debug,
		exitOnComplete: effectiveExitOnComplete,
		terminalShell,
		autonomous,
		taskTimeoutMs: autonomous ? flagOptions.timeout! * 1000 : undefined,
		providerBaseUrl: flagOptions.providerBaseUrl,
	}

	if (isOnboardingEnabled) {
		if (!settings.onboardingProviderChoice) {
			await runOnboarding()
		}
	}

	// Validations
	// TODO: Validate the API key for the chosen provider.
	// TODO: Validate the model for the chosen provider.

	extensionHostOptions.apiKey = flagOptions.apiKey || getApiKeyFromEnv(extensionHostOptions.provider)

	if (!extensionHostOptions.apiKey) {
		console.error(`[CLI] Error: No API key provided. Use --api-key or set the appropriate environment variable.`)
		console.error(`[CLI] For ${extensionHostOptions.provider}, set ${getEnvVarName(extensionHostOptions.provider)}`)

		exitValidation(`No API key provided for ${extensionHostOptions.provider}`)
	}

	if (!fs.existsSync(extensionHostOptions.workspacePath)) {
		console.error(`[CLI] Error: Workspace path does not exist: ${extensionHostOptions.workspacePath}`)
		exitValidation(`Workspace path does not exist: ${extensionHostOptions.workspacePath}`)
	}

	if (extensionHostOptions.reasoningEffort && !REASONING_EFFORTS.includes(extensionHostOptions.reasoningEffort)) {
		console.error(
			`[CLI] Error: Invalid reasoning effort: ${extensionHostOptions.reasoningEffort}, must be one of: ${REASONING_EFFORTS.join(", ")}`,
		)
		exitValidation(`Invalid reasoning effort: ${extensionHostOptions.reasoningEffort}`)
	}

	// Validate output format
	const outputFormat: OutputFormat = requestedOutputFormat

	if (!isValidOutputFormat(outputFormat)) {
		console.error(
			`[CLI] Error: Invalid output format: ${flagOptions.outputFormat}; must be one of: text, json, stream-json`,
		)
		exitValidation(`Invalid output format: ${flagOptions.outputFormat}`)
	}

	// Output format only works with --print mode
	if (outputFormat !== "text" && !flagOptions.print && isTuiSupported) {
		console.error("[CLI] Error: --output-format requires --print mode")
		console.error("[CLI] Usage: roo --print --output-format json")
		exitValidation("--output-format requires --print mode")
	}

	if (flagOptions.stdinPromptStream && !flagOptions.print) {
		console.error("[CLI] Error: --stdin-prompt-stream requires --print mode")
		console.error("[CLI] Usage: roo --print --output-format stream-json --stdin-prompt-stream [options]")
		exitValidation("--stdin-prompt-stream requires --print mode")
	}

	if (flagOptions.signalOnlyExit && !flagOptions.stdinPromptStream) {
		console.error("[CLI] Error: --signal-only-exit requires --stdin-prompt-stream")
		console.error("[CLI] Usage: roo --print --output-format stream-json --stdin-prompt-stream --signal-only-exit")
		exitValidation("--signal-only-exit requires --stdin-prompt-stream")
	}

	if (flagOptions.stdinPromptStream && outputFormat !== "stream-json") {
		console.error("[CLI] Error: --stdin-prompt-stream requires --output-format=stream-json")
		console.error("[CLI] Usage: roo --print --output-format stream-json --stdin-prompt-stream [options]")
		exitValidation("--stdin-prompt-stream requires --output-format=stream-json")
	}

	if (flagOptions.stdinPromptStream && process.stdin.isTTY) {
		console.error("[CLI] Error: --stdin-prompt-stream requires piped stdin")
		console.error(
			'[CLI] Example: printf \'{"command":"start","requestId":"1","prompt":"1+1=?"}\\n\' | roo --print --output-format stream-json --stdin-prompt-stream [options]',
		)
		exitValidation("--stdin-prompt-stream requires piped stdin")
	}

	if (flagOptions.stdinPromptStream && prompt) {
		console.error("[CLI] Error: cannot use positional prompt or --prompt-file with --stdin-prompt-stream")
		console.error("[CLI] Usage: roo --print --output-format stream-json --stdin-prompt-stream [options]")
		exitValidation("cannot use a prompt with --stdin-prompt-stream")
	}

	if (flagOptions.stdinPromptStream && requestedCreateSessionId) {
		console.error("[CLI] Error: --create-with-session-id is not supported with --stdin-prompt-stream")
		console.error('[CLI] Use per-request "taskId" in stdin start commands instead.')
		exitValidation("--create-with-session-id is not supported with --stdin-prompt-stream")
	}

	const useStdinPromptStream = flagOptions.stdinPromptStream
	let resolvedResumeSessionId: string | undefined

	if (isResumeRequested) {
		const workspaceSessions = await readWorkspaceTaskSessions(effectiveWorkspacePath)
		try {
			resolvedResumeSessionId = resolveWorkspaceResumeSessionId(workspaceSessions, requestedSessionId)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`[CLI] Error: ${message}`)
			exitValidation(message)
		}
	}

	if (!isTuiEnabled) {
		if (!prompt && !useStdinPromptStream && !isResumeRequested) {
			if (flagOptions.print) {
				console.error("[CLI] Error: no prompt provided")
				console.error("[CLI] Usage: roo --print [options] <prompt>")
				console.error(
					"[CLI] For stdin control mode: roo --print --output-format stream-json --stdin-prompt-stream [options]",
				)
			} else {
				console.error("[CLI] Error: prompt is required in non-interactive mode")
				console.error("[CLI] Usage: roo <prompt> [options]")
				console.error("[CLI] Run without -p for interactive mode")
			}

			exitValidation("no prompt provided")
		}

		if (!flagOptions.print) {
			console.warn("[CLI] TUI disabled (no TTY support), falling back to print mode")
		}
	}

	// Run!

	if (isTuiEnabled) {
		try {
			const { render } = await import("ink")
			const { App } = await import("../../ui/App.js")

			render(
				createElement(App, {
					...extensionHostOptions,
					initialPrompt: prompt,
					initialTaskId: requestedCreateSessionId,
					initialSessionId: resolvedResumeSessionId,
					continueSession: false,
					version: VERSION,
					createExtensionHost: (opts: ExtensionHostOptions) => new ExtensionHost(opts),
				}),
				// Handle Ctrl+C in App component for double-press exit.
				{ exitOnCtrlC: false },
			)
		} catch (error) {
			console.error("[CLI] Failed to start TUI:", error instanceof Error ? error.message : String(error))

			if (error instanceof Error) {
				console.error(error.stack)
			}

			exitValidation("failed to start TUI")
		}
	} else {
		const useJsonOutput = outputFormat === "json" || outputFormat === "stream-json"
		const signalOnlyExit = flagOptions.signalOnlyExit

		extensionHostOptions.disableOutput = useJsonOutput

		const host = new ExtensionHost(extensionHostOptions)
		let streamRequestId: string | undefined
		let keepAliveInterval: NodeJS.Timeout | undefined
		let isShuttingDown = false
		let hostDisposed = false

		const jsonEmitter = useJsonOutput
			? new JsonEventEmitter({
					mode: outputFormat as "json" | "stream-json",
					requestIdProvider: () => streamRequestId,
					authoritativeCompletion: autonomous,
				})
			: null
		let terminalEmitted = false

		const emitAutonomousTerminal = (
			state: AutonomousTerminalState,
			content?: string,
			rootTaskId?: string,
			exitCode = AUTONOMOUS_EXIT_CODES[state],
		) => {
			if (!autonomous || terminalEmitted) return
			terminalEmitted = true
			jsonEmitter?.emitTerminal({ state, exitCode, content, rootTaskId })
			if (!useJsonOutput && state !== "completed") {
				console.error(`[CLI] ${state}: ${content || state}`)
			}
		}

		const emitRuntimeError = (error: Error, source?: string) => {
			const errorMessage = source ? `${source}: ${error.message}` : error.message

			if (useJsonOutput) {
				const errorEvent = { type: "error", id: Date.now(), content: errorMessage }
				process.stdout.write(JSON.stringify(errorEvent) + "\n")
				return
			}

			console.error("[CLI] Error:", errorMessage)
			console.error(error.stack)
		}

		const clearKeepAliveInterval = () => {
			if (!keepAliveInterval) {
				return
			}

			clearInterval(keepAliveInterval)
			keepAliveInterval = undefined
		}

		const flushStdout = async () => {
			try {
				if (!process.stdout.writable || process.stdout.destroyed) {
					return
				}

				await new Promise<void>((resolve, reject) => {
					process.stdout.write("", (error?: Error | null) => {
						if (error) {
							reject(error)
							return
						}

						resolve()
					})
				})
			} catch {
				// Best effort: shutdown should proceed even if stdout flush fails.
			}
		}

		const ensureKeepAliveInterval = () => {
			if (!signalOnlyExit || keepAliveInterval) {
				return
			}

			keepAliveInterval = setInterval(() => {}, SIGNAL_ONLY_EXIT_KEEPALIVE_MS)
		}

		const disposeHost = async () => {
			if (hostDisposed) {
				return
			}

			hostDisposed = true
			jsonEmitter?.detach()
			await host.dispose()
		}

		const onSigint = () => {
			if (isShuttingDown) {
				process.off("SIGINT", onSigint)
				process.kill(process.pid, "SIGINT")
				return
			}
			void shutdown("SIGINT", 130)
		}

		const onSigterm = () => {
			if (isShuttingDown) {
				process.off("SIGTERM", onSigterm)
				process.kill(process.pid, "SIGTERM")
				return
			}
			void shutdown("SIGTERM", 143)
		}

		const onUncaughtException = (error: Error) => {
			if (
				isExpectedControlFlowError(error, {
					stdinStreamMode: useStdinPromptStream,
					shuttingDown: isShuttingDown,
					operation: "runtime",
				})
			) {
				return
			}

			if (!autonomous) emitRuntimeError(error, "uncaughtException")

			if (signalOnlyExit) {
				return
			}

			void shutdown("uncaughtException", AUTONOMOUS_EXIT_CODES.crashed, "crashed", error.message)
		}

		const onUnhandledRejection = (reason: unknown) => {
			if (
				isExpectedControlFlowError(reason, {
					stdinStreamMode: useStdinPromptStream,
					shuttingDown: isShuttingDown,
					operation: "runtime",
				})
			) {
				return
			}

			const error = normalizeError(reason)
			if (!autonomous) emitRuntimeError(error, "unhandledRejection")

			if (signalOnlyExit) {
				return
			}

			void shutdown("unhandledRejection", AUTONOMOUS_EXIT_CODES.crashed, "crashed", error.message)
		}

		const parkUntilSignal = async (reason: string): Promise<never> => {
			ensureKeepAliveInterval()

			if (!useJsonOutput) {
				console.error(`[CLI] ${reason} (--signal-only-exit active; waiting for SIGINT/SIGTERM).`)
			}

			await new Promise<void>(() => {})
			throw new Error("unreachable")
		}

		async function shutdown(
			signal: string,
			exitCode: number,
			terminalState: AutonomousTerminalState = "cancelled",
			terminalContent = `Received ${signal}`,
		): Promise<void> {
			if (isShuttingDown) {
				return
			}

			isShuttingDown = true
			process.off("uncaughtException", onUncaughtException)
			process.off("unhandledRejection", onUnhandledRejection)
			clearKeepAliveInterval()

			if (!useJsonOutput) {
				console.log(`\n[CLI] Received ${signal}, shutting down...`)
			}

			await host.cancelTask().catch(() => undefined)
			emitAutonomousTerminal(terminalState, terminalContent, host.getRootTaskId(), exitCode)
			await disposeHost()
			if (jsonEmitter) {
				await jsonEmitter.flush()
			}
			await flushStdout()
			process.off("SIGINT", onSigint)
			process.off("SIGTERM", onSigterm)
			process.exit(exitCode)
		}

		process.on("SIGINT", onSigint)
		process.on("SIGTERM", onSigterm)
		process.on("uncaughtException", onUncaughtException)
		process.on("unhandledRejection", onUnhandledRejection)

		try {
			await host.activate()

			if (jsonEmitter) {
				jsonEmitter.attachToClient(host.client)
			}

			if (useStdinPromptStream) {
				if (!jsonEmitter || outputFormat !== "stream-json") {
					throw new Error("--stdin-prompt-stream requires --output-format=stream-json to emit control events")
				}

				if (isResumeRequested) {
					await bootstrapResumeForStdinStream(host, resolvedResumeSessionId!)
				}

				await runStdinStreamMode({
					host,
					jsonEmitter,
					setStreamRequestId: (id) => {
						streamRequestId = id
					},
				})
			} else {
				if (isResumeRequested) {
					await host.resumeTask(resolvedResumeSessionId!)
				} else {
					await host.runTask(prompt!, requestedCreateSessionId)
				}
				if (isShuttingDown) await new Promise<void>(() => {})
				const taskResult = host.getLastTaskResult()
				emitAutonomousTerminal("completed", taskResult?.result, taskResult?.rootTaskId)
			}

			await disposeHost()
			if (jsonEmitter) {
				await jsonEmitter.flush()
			}
			await flushStdout()

			if (signalOnlyExit) {
				await parkUntilSignal("Task loop completed")
			}

			process.off("SIGINT", onSigint)
			process.off("SIGTERM", onSigterm)
			process.off("uncaughtException", onUncaughtException)
			process.off("unhandledRejection", onUnhandledRejection)
			process.exit(0)
		} catch (error) {
			if (isShuttingDown) await new Promise<void>(() => {})
			const normalizedError = normalizeError(error)
			const state = error instanceof AutonomousRunError ? error.state : "crashed"
			emitAutonomousTerminal(state, normalizedError.message, host.getRootTaskId())
			if (!autonomous) emitRuntimeError(normalizedError)
			await host.cancelTask().catch(() => undefined)
			await disposeHost()
			if (jsonEmitter) {
				await jsonEmitter.flush()
			}
			await flushStdout()

			if (signalOnlyExit) {
				await parkUntilSignal("Task loop failed")
			}

			process.off("SIGINT", onSigint)
			process.off("SIGTERM", onSigterm)
			process.off("uncaughtException", onUncaughtException)
			process.off("unhandledRejection", onUnhandledRejection)
			process.exit(autonomous ? AUTONOMOUS_EXIT_CODES[state] : 1)
		}
	}
}
