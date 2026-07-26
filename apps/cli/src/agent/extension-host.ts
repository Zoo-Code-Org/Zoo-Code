/**
 * ExtensionHost - Loads and runs the Roo Code extension in CLI mode
 *
 * This class is a thin coordination layer responsible for:
 * 1. Creating the vscode-shim mock
 * 2. Loading the extension bundle via require()
 * 3. Activating the extension
 * 4. Wiring up managers for output, prompting, and ask handling
 */

import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"
import fs from "fs"
import { EventEmitter } from "events"
import { randomUUID } from "crypto"

import pWaitFor from "p-wait-for"

import {
	RooCodeEventName,
	type RooCodeAPI,
	type RooCodeSettings,
	type ClineMessage,
	type ExtensionMessage,
	type ReasoningEffortExtended,
	type WebviewMessage,
} from "@roo-code/types"
import { createVSCodeAPI, IExtensionHost, ExtensionHostEventMap, setRuntimeConfigValues } from "@roo-code/vscode-shim"
import { DebugLogger, setDebugLogEnabled } from "@roo-code/core/cli"

import { DEFAULT_FLAGS, type SupportedProvider } from "@/types/index.js"
import type { User } from "@/lib/sdk/index.js"
import { getProviderSettings } from "@/lib/utils/provider.js"
import { createEphemeralStorageDir } from "@/lib/storage/index.js"

import type { WaitingForInputEvent, TaskCompletedEvent } from "./events.js"
import type { AgentStateInfo } from "./agent-state.js"
import { ExtensionClient } from "./extension-client.js"
import { OutputManager } from "./output-manager.js"
import { PromptManager } from "./prompt-manager.js"
import { AskDispatcher } from "./ask-dispatcher.js"
import { AutonomousRunError, type TaskRunResult } from "./autonomous-run.js"

// Pre-configured logger for CLI message activity debugging.
const cliLogger = new DebugLogger("CLI")

// Get the CLI package root directory (for finding node_modules/@vscode/ripgrep)
// When running from a release tarball, ROO_CLI_ROOT is set by the wrapper script.
// In development, we fall back to finding the CLI package root by walking up to package.json.
// This works whether running from dist/ (bundled) or src/agent/ (tsx dev).
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findCliPackageRoot(): string {
	let dir = __dirname

	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir
		}

		dir = path.dirname(dir)
	}

	return path.resolve(__dirname, "..")
}

const CLI_PACKAGE_ROOT = process.env.ROO_CLI_ROOT || findCliPackageRoot()
const CANCELLATION_SETTLE_TIMEOUT_MS = 5_000

export interface ExtensionHostOptions {
	mode: string
	reasoningEffort?: ReasoningEffortExtended | "unspecified" | "disabled"
	consecutiveMistakeLimit?: number
	user: User | null
	provider: SupportedProvider
	apiKey?: string
	model: string
	providerBaseUrl?: string
	workspacePath: string
	extensionPath: string
	nonInteractive?: boolean
	/**
	 * When true, uses a temporary storage directory that is cleaned up on exit.
	 */
	ephemeral: boolean
	debug: boolean
	exitOnComplete: boolean
	terminalShell?: string
	/**
	 * When true, exit the process on API request errors instead of retrying.
	 */
	exitOnError?: boolean
	/** Run the dangerous, unrestricted autonomous Orchestrator profile. */
	autonomous?: boolean
	/** Wall-clock deadline for the complete root task tree. */
	taskTimeoutMs?: number
	/**
	 * When true, completely disables all direct stdout/stderr output.
	 * Use this when running in TUI mode where Ink controls the terminal.
	 */
	disableOutput?: boolean
	/** Disable ask routing because another UI owns it (TUI only). */
	disableAskHandling?: boolean
	/**
	 * When true, don't suppress node warnings and console output since we're
	 * running in an integration test and we want to see the output.
	 */
	integrationTest?: boolean
}

interface ExtensionModule {
	activate: (context: unknown) => Promise<unknown>
	deactivate?: () => Promise<void>
}

interface WebviewViewProvider {
	resolveWebviewView?(webviewView: unknown, context: unknown, token: unknown): void | Promise<void>
}

export interface ExtensionHostInterface extends IExtensionHost<ExtensionHostEventMap> {
	client: ExtensionClient
	activate(): Promise<void>
	runTask(prompt: string, taskId?: string, configuration?: RooCodeSettings, images?: string[]): Promise<void>
	resumeTask(taskId: string): Promise<void>
	cancelTask(): Promise<void>
	sendToExtension(message: WebviewMessage): Promise<void>
	dispose(): Promise<void>
}

export class ExtensionHost extends EventEmitter implements ExtensionHostInterface {
	// Extension lifecycle.
	private vscode: ReturnType<typeof createVSCodeAPI> | null = null
	private extensionModule: ExtensionModule | null = null
	private extensionAPI: RooCodeAPI | null = null
	private options: ExtensionHostOptions
	private isReady = false
	private messageListener: ((message: ExtensionMessage) => void) | null = null
	private initialSettings: RooCodeSettings

	// Console suppression.
	private originalConsole: {
		log: typeof console.log
		warn: typeof console.warn
		error: typeof console.error
		debug: typeof console.debug
		info: typeof console.info
	} | null = null

	private originalProcessEmitWarning: typeof process.emitWarning | null = null

	// Ephemeral storage.
	private ephemeralStorageDir: string | null = null
	private previousCliRuntimeEnv: string | undefined
	private previousCliAutonomousEnv: string | undefined
	private initializationPromise: Promise<void> = Promise.resolve()
	private lastTaskResult: TaskRunResult | undefined
	private rootTaskId: string | undefined

	// ==========================================================================
	// Managers - These do all the heavy lifting
	// ==========================================================================

	/**
	 * ExtensionClient: Single source of truth for agent loop state.
	 * Handles message processing and state detection.
	 */
	public readonly client: ExtensionClient

	/**
	 * OutputManager: Handles all CLI output and streaming.
	 * Uses Observable pattern internally for stream tracking.
	 */
	private outputManager: OutputManager

	/**
	 * PromptManager: Handles all user input collection.
	 * Provides readline, yes/no, and timed prompts.
	 */
	private promptManager: PromptManager

	/**
	 * AskDispatcher: Routes asks to appropriate handlers.
	 * Uses type guards (isIdleAsk, isInteractiveAsk, etc.) from client module.
	 */
	private askDispatcher: AskDispatcher

	// ==========================================================================
	// Constructor
	// ==========================================================================

	constructor(options: ExtensionHostOptions) {
		super()

		this.options = options
		// Mark this process as CLI runtime so extension code can apply
		// CLI-specific behavior without affecting VS Code desktop usage.
		this.previousCliRuntimeEnv = process.env.ROO_CLI_RUNTIME
		process.env.ROO_CLI_RUNTIME = "1"
		this.previousCliAutonomousEnv = process.env.ROO_CLI_AUTONOMOUS
		if (options.autonomous) {
			process.env.ROO_CLI_AUTONOMOUS = "1"
		}

		// Enable file-based debug logging only when --debug is passed.
		if (options.debug) {
			setDebugLogEnabled(true)
		}

		// Set up quiet mode early, before any extension code runs.
		// This suppresses console output from the extension during load.
		this.setupQuietMode()

		// Initialize client - single source of truth for agent state (including mode).
		this.client = new ExtensionClient({
			sendMessage: (msg) => {
				void this.sendToExtension(msg)
			},
			debug: options.debug, // Enable debug logging in the client.
		})

		// Initialize output manager.
		this.outputManager = new OutputManager({ disabled: options.disableOutput })

		// Initialize prompt manager with console mode callbacks.
		this.promptManager = new PromptManager({
			onBeforePrompt: () => this.restoreConsole(),
			onAfterPrompt: () => this.setupQuietMode(),
		})

		// Initialize ask dispatcher.
		this.askDispatcher = new AskDispatcher({
			outputManager: this.outputManager,
			promptManager: this.promptManager,
			sendMessage: (msg) => {
				void this.sendToExtension(msg)
			},
			nonInteractive: options.autonomous || options.nonInteractive,
			exitOnError: options.exitOnError,
			disabled: options.disableAskHandling,
			onInputRequired: options.autonomous
				? (ask, text) => {
						const state = ask === "api_req_failed" ? "provider_failed" : "needs_input"
						this.client
							.getEmitter()
							.emit(
								"error",
								new AutonomousRunError(state, `${ask}: ${text || "human input is required"}`),
							)
					}
				: undefined,
		})

		// Wire up client events.
		this.setupClientEventHandlers()

		// Populate initial settings.
		const baseSettings: RooCodeSettings = {
			mode: this.options.autonomous ? "orchestrator" : this.options.mode,
			consecutiveMistakeLimit: this.options.consecutiveMistakeLimit ?? DEFAULT_FLAGS.consecutiveMistakeLimit,
			commandExecutionTimeout: 300,
			enableCheckpoints: false,
			experiments: {
				customTools: true,
			},
			...getProviderSettings(
				this.options.provider,
				this.options.apiKey,
				this.options.model,
				this.options.providerBaseUrl,
			),
		}

		this.initialSettings =
			this.options.autonomous || this.options.nonInteractive
				? {
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowReadOnlyOutsideWorkspace: true,
						alwaysAllowWrite: true,
						alwaysAllowWriteOutsideWorkspace: true,
						alwaysAllowWriteProtected: true,
						alwaysAllowMcp: true,
						alwaysAllowModeSwitch: true,
						alwaysAllowSubtasks: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
						...baseSettings,
					}
				: {
						autoApprovalEnabled: false,
						...baseSettings,
					}

		if (this.options.reasoningEffort && this.options.reasoningEffort !== "unspecified") {
			if (this.options.reasoningEffort === "disabled") {
				this.initialSettings.enableReasoningEffort = false
			} else {
				this.initialSettings.enableReasoningEffort = true
				this.initialSettings.reasoningEffort = this.options.reasoningEffort
			}
		}

		if (this.options.terminalShell) {
			this.initialSettings.terminalShellIntegrationDisabled = true
			this.initialSettings.execaShellPath = this.options.terminalShell
		}
	}

	// ==========================================================================
	// Client Event Handlers
	// ==========================================================================

	/**
	 * Wire up client events to managers.
	 * The client emits events, managers handle them.
	 */
	private setupClientEventHandlers(): void {
		// Handle new messages - delegate to OutputManager.
		this.client.on("message", (msg: ClineMessage) => {
			this.logMessageDebug(msg, "new")
			this.outputManager.outputMessage(msg)
		})

		// Handle message updates - delegate to OutputManager.
		this.client.on("messageUpdated", (msg: ClineMessage) => {
			this.logMessageDebug(msg, "updated")
			this.outputManager.outputMessage(msg)
		})

		// Handle waiting for input - delegate to AskDispatcher.
		this.client.on("waitingForInput", (event: WaitingForInputEvent) => {
			this.askDispatcher.handleAsk(event.message)
		})

		// Handle task completion.
		this.client.on("taskCompleted", (event: TaskCompletedEvent) => {
			// Output completion message via OutputManager.
			// Note: completion_result is an "ask" type, not a "say" type.
			if (event.message && event.message.type === "ask" && event.message.ask === "completion_result") {
				this.outputManager.outputCompletionResult(event.message.ts, event.message.text || "")
			}
		})
	}

	// ==========================================================================
	// Logging + Console Suppression
	// ==========================================================================

	private setupQuietMode(): void {
		// Skip if already set up or if integrationTest mode
		if (this.originalConsole || this.options.integrationTest) {
			return
		}

		// Suppress node warnings.
		this.originalProcessEmitWarning = process.emitWarning
		process.emitWarning = () => {}
		process.on("warning", () => {})

		// Suppress console output.
		this.originalConsole = {
			log: console.log,
			warn: console.warn,
			error: console.error,
			debug: console.debug,
			info: console.info,
		}

		console.log = () => {}
		console.warn = () => {}
		console.debug = () => {}
		console.info = () => {}
	}

	private restoreConsole(): void {
		if (!this.originalConsole) {
			return
		}

		console.log = this.originalConsole.log
		console.warn = this.originalConsole.warn
		console.error = this.originalConsole.error
		console.debug = this.originalConsole.debug
		console.info = this.originalConsole.info
		this.originalConsole = null

		if (this.originalProcessEmitWarning) {
			process.emitWarning = this.originalProcessEmitWarning
			this.originalProcessEmitWarning = null
		}
	}

	private logMessageDebug(msg: ClineMessage, type: "new" | "updated"): void {
		if (msg.partial) {
			if (!this.outputManager.hasLoggedFirstPartial(msg.ts)) {
				this.outputManager.setLoggedFirstPartial(msg.ts)
				cliLogger.debug("message:start", { ts: msg.ts, type: msg.say || msg.ask })
			}
		} else {
			cliLogger.debug(`message:${type === "new" ? "new" : "complete"}`, { ts: msg.ts, type: msg.say || msg.ask })
			this.outputManager.clearLoggedFirstPartial(msg.ts)
		}
	}

	// ==========================================================================
	// Extension Lifecycle
	// ==========================================================================

	public async activate(): Promise<void> {
		const bundlePath = path.join(this.options.extensionPath, "extension.js")

		if (!fs.existsSync(bundlePath)) {
			this.restoreConsole()
			throw new Error(`Extension bundle not found at: ${bundlePath}`)
		}

		let storageDir: string | undefined

		if (this.options.ephemeral) {
			this.ephemeralStorageDir = await createEphemeralStorageDir()
			storageDir = this.ephemeralStorageDir
		}

		// Create VSCode API mock.
		this.vscode = createVSCodeAPI(this.options.extensionPath, this.options.workspacePath, undefined, {
			appRoot: CLI_PACKAGE_ROOT,
			storageDir,
		})
		;(global as Record<string, unknown>).vscode = this.vscode
		;(global as Record<string, unknown>).__extensionHost = this

		// Set up module resolution.
		const require = createRequire(import.meta.url)
		const Module = require("module")
		const originalResolve = Module._resolveFilename

		Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
			if (request === "vscode") return "vscode-mock"
			return originalResolve.call(this, request, parent, isMain, options)
		}

		require.cache["vscode-mock"] = {
			id: "vscode-mock",
			filename: "vscode-mock",
			loaded: true,
			exports: this.vscode,
			children: [],
			paths: [],
			path: "",
			isPreloading: false,
			parent: null,
			require: require,
		} as unknown as NodeJS.Module

		try {
			this.extensionModule = require(bundlePath) as ExtensionModule
		} catch (error) {
			Module._resolveFilename = originalResolve

			throw new Error(
				`Failed to load extension bundle: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		Module._resolveFilename = originalResolve

		try {
			this.extensionAPI = (await this.extensionModule.activate(this.vscode.context)) as RooCodeAPI
		} catch (error) {
			throw new Error(`Failed to activate extension: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Set up message listener - forward all messages to client.
		this.messageListener = (message: ExtensionMessage) => this.client.handleMessage(message)
		this.on("extensionWebviewMessage", this.messageListener)

		await pWaitFor(() => this.isReady, { interval: 100, timeout: 10_000 })
		await this.initializationPromise
	}

	public registerWebviewProvider(_viewId: string, _provider: WebviewViewProvider): void {}

	public unregisterWebviewProvider(_viewId: string): void {}

	public markWebviewReady(): void {
		this.isReady = true

		// Apply CLI settings to the runtime config and context proxy BEFORE
		// sending webviewDidLaunch. This prevents a race condition where the
		// webviewDidLaunch handler's first-time init sync reads default state
		// (apiProvider: "anthropic") instead of the CLI-provided settings.
		setRuntimeConfigValues("zoo-code", this.initialSettings as Record<string, unknown>)
		// Serialize initial settings and launch. In particular, webviewDidLaunch
		// loads project custom modes before activate() allows the first task.
		this.initializationPromise = (async () => {
			await this.dispatchToExtension({ type: "updateSettings", updatedSettings: this.initialSettings })
			await this.dispatchToExtension({ type: "webviewDidLaunch" })
		})()
	}

	public isInInitialSetup(): boolean {
		return !this.isReady
	}

	// ==========================================================================
	// Message Handling
	// ==========================================================================

	public async sendToExtension(message: WebviewMessage): Promise<void> {
		if (!this.isReady) {
			throw new Error("You cannot send messages to the extension before it is ready")
		}

		await this.initializationPromise
		this.emit("webviewMessage", message)
	}

	private async dispatchToExtension(message: WebviewMessage): Promise<void> {
		if (!this.isReady) {
			throw new Error("You cannot send messages to the extension before it is ready")
		}

		const listeners = this.listeners("webviewMessage") as Array<(message: WebviewMessage) => unknown>
		if (listeners.length === 0) {
			this.emit("webviewMessage", message)
			return
		}
		await Promise.all(listeners.map((listener) => listener(message)))
	}

	// ==========================================================================
	// Task Management
	// ==========================================================================

	private waitForTaskCompletion(rootTaskId: string): Promise<TaskRunResult> {
		if (!this.options.autonomous) {
			return new Promise((resolve, reject) => {
				const completeHandler = (event: TaskCompletedEvent) => {
					cleanup()
					resolve({ rootTaskId, result: event.message?.text })
				}
				const errorHandler = (error: Error) => {
					cleanup()
					reject(error)
				}
				const cleanup = () => {
					this.client.off("taskCompleted", completeHandler)
					this.client.off("error", errorHandler)
				}
				this.client.once("taskCompleted", completeHandler)
				this.client.once("error", errorHandler)
			})
		}

		const api = this.extensionAPI
		if (!api) {
			return Promise.reject(new Error("Extension API is unavailable"))
		}

		return new Promise((resolve, reject) => {
			let result: string | undefined
			let timeout: NodeJS.Timeout | undefined

			const completeHandler = (
				taskId: string,
				_tokenUsage: unknown,
				_toolUsage: unknown,
				metadata: { isSubtask: boolean },
			) => {
				if (taskId !== rootTaskId || metadata.isSubtask) return
				void pWaitFor(async () => (await api.getTaskHistoryItem(rootTaskId))?.status === "completed", {
					interval: 25,
					timeout: 5_000,
				})
					.then(() => {
						cleanup()
						resolve({ rootTaskId, result })
					})
					.catch(errorHandler)
			}

			const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
				if (taskId !== rootTaskId || message.partial) return

				if (message.type === "say" && message.say === "completion_result") {
					result = message.text
				}

				if (this.options.autonomous && message.type === "ask" && message.ask === "completion_result") {
					void api.approveCurrentAsk()
				}
			}

			const errorHandler = (error: Error) => {
				cleanup()
				reject(error)
			}
			const retryHandler = (message: ClineMessage) => {
				if (message.type !== "say" || message.say !== "api_req_retry_delayed") return
				cleanup()
				reject(new AutonomousRunError("provider_failed", message.text?.split("\n")[0] || "API request failed"))
			}

			const cleanup = () => {
				this.client.off("error", errorHandler)
				this.client.off("message", retryHandler)
				api.off(RooCodeEventName.TaskCompleted, completeHandler)
				api.off(RooCodeEventName.Message, messageHandler)
				if (timeout) clearTimeout(timeout)
			}

			api.on(RooCodeEventName.TaskCompleted, completeHandler)
			api.on(RooCodeEventName.Message, messageHandler)
			this.client.on("error", errorHandler)
			this.client.on("message", retryHandler)

			if (this.options.taskTimeoutMs) {
				timeout = setTimeout(() => {
					cleanup()
					const cancellation = api.cancelCurrentTask().catch(() => undefined)
					let settleTimer: NodeJS.Timeout
					const settleDeadline = new Promise<void>((resolve) => {
						settleTimer = setTimeout(resolve, CANCELLATION_SETTLE_TIMEOUT_MS)
					})
					void Promise.race([cancellation, settleDeadline]).then(() => {
						clearTimeout(settleTimer)
						reject(
							new AutonomousRunError("timed_out", `Root task exceeded ${this.options.taskTimeoutMs}ms`),
						)
					})
				}, this.options.taskTimeoutMs)
			}
		})
	}

	public async runTask(
		prompt: string,
		taskId?: string,
		configuration?: RooCodeSettings,
		images?: string[],
	): Promise<void> {
		const rootTaskId = taskId ?? (this.options.autonomous ? randomUUID() : "unknown")
		this.rootTaskId = rootTaskId
		const completion = this.waitForTaskCompletion(rootTaskId)
		await this.sendToExtension({
			type: "newTask",
			text: prompt,
			...(taskId || this.options.autonomous ? { taskId: rootTaskId } : {}),
			taskConfiguration: configuration,
			...(images !== undefined ? { images } : {}),
		})
		this.lastTaskResult = await completion
	}

	public async resumeTask(taskId: string): Promise<void> {
		this.rootTaskId = taskId
		const completion = this.waitForTaskCompletion(taskId)
		await this.sendToExtension({ type: "showTaskWithId", text: taskId })
		this.lastTaskResult = await completion
	}

	public getLastTaskResult(): TaskRunResult | undefined {
		return this.lastTaskResult
	}

	public getRootTaskId(): string | undefined {
		return this.rootTaskId
	}

	public async cancelTask(): Promise<void> {
		await this.extensionAPI?.cancelCurrentTask()
	}

	// ==========================================================================
	// Public Agent State API
	// ==========================================================================

	/**
	 * Get the current agent loop state.
	 */
	public getAgentState(): AgentStateInfo {
		return this.client.getAgentState()
	}

	/**
	 * Check if the agent is currently waiting for user input.
	 */
	public isWaitingForInput(): boolean {
		return this.client.getAgentState().isWaitingForInput
	}

	// ==========================================================================
	// Cleanup
	// ==========================================================================

	async dispose(): Promise<void> {
		// Clear managers.
		this.outputManager.clear()
		this.askDispatcher.clear()

		// Remove message listener.
		if (this.messageListener) {
			this.off("extensionWebviewMessage", this.messageListener)
			this.messageListener = null
		}

		// Reset client.
		this.client.reset()

		// Deactivate extension.
		if (this.extensionModule?.deactivate) {
			try {
				await this.extensionModule.deactivate()
			} catch {
				// NO-OP
			}
		}

		// Clear references.
		this.vscode = null
		this.extensionModule = null
		this.extensionAPI = null

		// Clear globals.
		delete (global as Record<string, unknown>).vscode
		delete (global as Record<string, unknown>).__extensionHost

		// Keep extension logs suppressed until an autonomous machine-readable
		// process exits; background task disposal can otherwise corrupt NDJSON.
		if (!(this.options.autonomous && this.options.disableOutput)) {
			this.restoreConsole()
		}

		// Clean up ephemeral storage.
		if (this.ephemeralStorageDir) {
			try {
				await fs.promises.rm(this.ephemeralStorageDir, { recursive: true, force: true })
				this.ephemeralStorageDir = null
			} catch {
				// NO-OP
			}
		}

		// Restore previous CLI runtime marker for process hygiene in tests.
		if (this.previousCliRuntimeEnv === undefined) {
			delete process.env.ROO_CLI_RUNTIME
		} else {
			process.env.ROO_CLI_RUNTIME = this.previousCliRuntimeEnv
		}

		if (this.previousCliAutonomousEnv === undefined) {
			delete process.env.ROO_CLI_AUTONOMOUS
		} else {
			process.env.ROO_CLI_AUTONOMOUS = this.previousCliAutonomousEnv
		}
	}
}
