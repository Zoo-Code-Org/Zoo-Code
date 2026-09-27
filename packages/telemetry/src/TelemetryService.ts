import { ZodError } from "zod"

import {
	type TelemetryClient,
	type TelemetryPropertiesProvider,
	TelemetryEventName,
	type TelemetrySetting,
	type ToolUsage,
} from "@roo-code/types"

/**
 * Events prone to retry-storm-style repetition (e.g. a broken embedder config
 * re-triggering on every file-system event). Guarded by a circuit breaker in
 * `captureEvent` so a single broken install can't flood the Product Analytics
 * quota. Tracked per-event via a sliding time window, independent of any
 * other telemetry the same install may also be sending.
 */
const CIRCUIT_BREAKER_GUARDED_EVENTS = new Set<TelemetryEventName>([TelemetryEventName.CODE_INDEX_ERROR])

/** Captures of a guarded event within the counting window allowed before the breaker trips. */
const CIRCUIT_BREAKER_MAX_IN_WINDOW = 50

/** Rolling window over which guarded-event occurrences are counted. */
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000

/** How long a tripped breaker stays tripped before allowing captures again. */
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000

/**
 * Upper bound applied separately to each phase of shutdown(): draining in-flight capture
 * calls, then awaiting client.shutdown(). deactivate() awaits shutdown() before terminal
 * cleanup, so an unbounded wait in either phase (e.g. a capture stuck on network I/O, or
 * a client's own shutdown() -- posthog-node defaults to a 30s internal timeout -- never
 * settling) would block the extension host from ever finishing deactivation. Losing an
 * in-flight capture, or a client's graceful flush, on timeout is an acceptable tradeoff
 * against blocking shutdown indefinitely. Worst case, shutdown() takes up to roughly
 * 2 * SHUTDOWN_PHASE_TIMEOUT_MS.
 */
const SHUTDOWN_PHASE_TIMEOUT_MS = 3000

/**
 * TelemetryService wrapper class that defers initialization.
 * This ensures that we only create the various clients after environment
 * variables are loaded.
 */
export class TelemetryService {
	// Timestamps of recent guarded-event occurrences, per event name, oldest first.
	private guardedEventOccurrences = new Map<TelemetryEventName, number[]>()
	private trippedUntil = new Map<TelemetryEventName, number>()

	// In-flight client.capture()/captureException() promises. captureEvent/captureException are
	// synchronous (void-returning) for callers, but the underlying client calls are async (e.g.
	// PostHogTelemetryClient awaits property enrichment before enqueueing). Tracked here so
	// shutdown() can drain them before flushing/closing the clients -- otherwise a capture that's
	// still mid-flight when shutdown() runs could be lost entirely.
	private pendingClientCalls = new Set<Promise<unknown>>()

	// Set at the start of shutdown() so new captureEvent/captureException calls stop being
	// tracked (and, once clients are closing, stop being sent) instead of racing the drain.
	private isShuttingDown = false

	constructor(private clients: TelemetryClient[]) {}

	private trackPendingClientCall(promise: Promise<unknown>): void {
		// Never let a rejected client call surface as an unhandled rejection or block shutdown.
		const tracked = promise.catch(() => undefined)
		this.pendingClientCalls.add(tracked)
		void tracked.finally(() => this.pendingClientCalls.delete(tracked))
	}

	public register(client: TelemetryClient): void {
		this.clients.push(client)
	}

	/**
	 * Sets the ClineProvider reference to use for global properties
	 * @param provider A ClineProvider instance to use
	 */
	public setProvider(provider: TelemetryPropertiesProvider): void {
		// If client is initialized, pass the provider reference.
		if (this.isReady) {
			this.clients.forEach((client) => client.setProvider(provider))
		}
	}

	/**
	 * Base method for all telemetry operations
	 * Checks if the service is initialized before performing any operation
	 * @returns Whether the service is ready to use
	 */
	private get isReady(): boolean {
		return this.clients.length > 0
	}

	/**
	 * Updates the telemetry state based on user preferences and VSCode settings
	 * @param isOptedIn Whether the user is opted into telemetry
	 */
	public updateTelemetryState(isOptedIn: boolean): void {
		if (!this.isReady) {
			return
		}

		this.clients.forEach((client) => client.updateTelemetryState(isOptedIn))
	}

	/**
	 * Checks whether a guarded event should be dropped by the circuit breaker,
	 * updating the breaker's internal state as a side effect. Tracked entirely
	 * independently of other event names -- unrelated telemetry from the same
	 * install must never mask (or count towards) a guarded-event burst.
	 */
	private shouldDropForCircuitBreaker(eventName: TelemetryEventName): boolean {
		if (!CIRCUIT_BREAKER_GUARDED_EVENTS.has(eventName)) {
			return false
		}

		const now = Date.now()

		const trippedUntil = this.trippedUntil.get(eventName)
		if (trippedUntil !== undefined) {
			if (now < trippedUntil) {
				return true
			}

			// Cooldown elapsed - reset and allow this capture through.
			this.trippedUntil.delete(eventName)
			this.guardedEventOccurrences.delete(eventName)
		}

		const windowStart = now - CIRCUIT_BREAKER_WINDOW_MS
		const occurrences = (this.guardedEventOccurrences.get(eventName) ?? []).filter((ts) => ts > windowStart)
		occurrences.push(now)
		this.guardedEventOccurrences.set(eventName, occurrences)

		if (occurrences.length >= CIRCUIT_BREAKER_MAX_IN_WINDOW) {
			this.trippedUntil.set(eventName, now + CIRCUIT_BREAKER_COOLDOWN_MS)
			this.guardedEventOccurrences.delete(eventName)
			return true
		}

		return false
	}

	/**
	 * Generic method to capture any type of event with specified properties
	 * @param eventName The event name to capture
	 * @param properties The event properties
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public captureEvent(eventName: TelemetryEventName, properties?: Record<string, any>): void {
		if (!this.isReady || this.isShuttingDown) {
			return
		}

		if (this.shouldDropForCircuitBreaker(eventName)) {
			return
		}

		this.clients.forEach((client) => this.trackPendingClientCall(client.capture({ event: eventName, properties })))
	}

	/**
	 * Captures an exception using PostHog's error tracking
	 * @param error The error to capture
	 * @param additionalProperties Additional properties to include with the exception
	 */
	public captureException(error: Error, additionalProperties?: Record<string, unknown>): void {
		if (!this.isReady || this.isShuttingDown) {
			return
		}

		this.clients.forEach((client) =>
			this.trackPendingClientCall(client.captureException(error, additionalProperties)),
		)
	}

	public captureTaskCreated(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_CREATED, { taskId })
	}

	public captureTaskRestarted(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_RESTARTED, { taskId })
	}

	/**
	 * Captures task completion, summarizing per-task tool and message counts that
	 * were previously reported as separate per-turn events to reduce event volume.
	 *
	 * A single task may emit this more than once (e.g. an "idle" or "shutdown"
	 * installment followed by a final "attempt_completion" one). toolsUsed and
	 * messageCount are always deltas since the previous emission for that task,
	 * not running totals -- summing installments for a taskId reconstructs the
	 * full-task counts without double-counting.
	 *
	 * Note: "attempt_completion" means the model called that tool, not that the
	 * user accepted the result.
	 */
	public captureTaskCompleted(
		taskId: string,
		toolsUsed?: ToolUsage,
		messageCount?: { user: number; assistant: number },
		completionReason: "attempt_completion" | "idle" | "shutdown" = "attempt_completion",
	): void {
		this.captureEvent(TelemetryEventName.TASK_COMPLETED, {
			taskId,
			completionReason,
			...(toolsUsed !== undefined && { toolsUsed }),
			...(messageCount !== undefined && { messageCount }),
		})
	}

	public captureConversationMessage(taskId: string, source: "user" | "assistant"): void {
		this.captureEvent(TelemetryEventName.TASK_CONVERSATION_MESSAGE, { taskId, source })
	}

	public captureLlmCompletion(
		taskId: string,
		properties: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			cost?: number
		},
	): void {
		this.captureEvent(TelemetryEventName.LLM_COMPLETION, { taskId, ...properties })
	}

	public captureModeSwitch(taskId: string, newMode: string): void {
		this.captureEvent(TelemetryEventName.MODE_SWITCH, { taskId, newMode })
	}

	public captureToolUsage(taskId: string, tool: string): void {
		this.captureEvent(TelemetryEventName.TOOL_USED, { taskId, tool })
	}

	public captureCheckpointCreated(taskId: string): void {
		this.captureEvent(TelemetryEventName.CHECKPOINT_CREATED, { taskId })
	}

	public captureCheckpointDiffed(taskId: string): void {
		this.captureEvent(TelemetryEventName.CHECKPOINT_DIFFED, { taskId })
	}

	public captureCheckpointRestored(taskId: string): void {
		this.captureEvent(TelemetryEventName.CHECKPOINT_RESTORED, { taskId })
	}

	public captureContextCondensed(taskId: string, isAutomaticTrigger: boolean, usedCustomPrompt?: boolean): void {
		this.captureEvent(TelemetryEventName.CONTEXT_CONDENSED, {
			taskId,
			isAutomaticTrigger,
			...(usedCustomPrompt !== undefined && { usedCustomPrompt }),
		})
	}

	public captureSlidingWindowTruncation(taskId: string): void {
		this.captureEvent(TelemetryEventName.SLIDING_WINDOW_TRUNCATION, { taskId })
	}

	public captureCodeActionUsed(actionType: string): void {
		this.captureEvent(TelemetryEventName.CODE_ACTION_USED, { actionType })
	}

	public capturePromptEnhanced(taskId?: string): void {
		this.captureEvent(TelemetryEventName.PROMPT_ENHANCED, { ...(taskId && { taskId }) })
	}

	public captureSchemaValidationError({ schemaName, error }: { schemaName: string; error: ZodError }): void {
		// https://zod.dev/ERROR_HANDLING?id=formatting-errors
		this.captureEvent(TelemetryEventName.SCHEMA_VALIDATION_ERROR, { schemaName, error: error.format() })
	}

	public captureDiffApplicationError(taskId: string, consecutiveMistakeCount: number): void {
		this.captureEvent(TelemetryEventName.DIFF_APPLICATION_ERROR, { taskId, consecutiveMistakeCount })
	}

	public captureShellIntegrationError(taskId: string): void {
		this.captureEvent(TelemetryEventName.SHELL_INTEGRATION_ERROR, { taskId })
	}

	public captureConsecutiveMistakeError(taskId: string): void {
		this.captureEvent(TelemetryEventName.CONSECUTIVE_MISTAKE_ERROR, { taskId })
	}

	/**
	 * Captures when a tab is shown due to user action
	 * @param tab The tab that was shown
	 */
	public captureTabShown(tab: string): void {
		this.captureEvent(TelemetryEventName.TAB_SHOWN, { tab })
	}

	/**
	 * Captures when a setting is changed in ModesView
	 * @param settingName The name of the setting that was changed
	 */
	public captureModeSettingChanged(settingName: string): void {
		this.captureEvent(TelemetryEventName.MODE_SETTINGS_CHANGED, { settingName })
	}

	/**
	 * Captures when a user creates a new custom mode
	 * @param modeSlug The slug of the custom mode
	 * @param modeName The name of the custom mode
	 */
	public captureCustomModeCreated(modeSlug: string, modeName: string): void {
		this.captureEvent(TelemetryEventName.CUSTOM_MODE_CREATED, { modeSlug, modeName })
	}

	/**
	 * Captures a marketplace item installation event
	 * @param itemId The unique identifier of the marketplace item
	 * @param itemType The type of item (mode or mcp)
	 * @param itemName The human-readable name of the item
	 * @param target The installation target (project or global)
	 * @param properties Additional properties like hasParameters, installationMethod
	 */
	public captureMarketplaceItemInstalled(
		itemId: string,
		itemType: string,
		itemName: string,
		target: string,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		properties?: Record<string, any>,
	): void {
		this.captureEvent(TelemetryEventName.MARKETPLACE_ITEM_INSTALLED, {
			itemId,
			itemType,
			itemName,
			target,
			...(properties || {}),
		})
	}

	/**
	 * Captures a marketplace item removal event
	 * @param itemId The unique identifier of the marketplace item
	 * @param itemType The type of item (mode or mcp)
	 * @param itemName The human-readable name of the item
	 * @param target The removal target (project or global)
	 */
	public captureMarketplaceItemRemoved(itemId: string, itemType: string, itemName: string, target: string): void {
		this.captureEvent(TelemetryEventName.MARKETPLACE_ITEM_REMOVED, {
			itemId,
			itemType,
			itemName,
			target,
		})
	}

	/**
	 * Captures a title button click event
	 * @param button The button that was clicked
	 */
	public captureTitleButtonClicked(button: string): void {
		this.captureEvent(TelemetryEventName.TITLE_BUTTON_CLICKED, { button })
	}

	/**
	 * Captures when telemetry settings are changed
	 * @param previousSetting The previous telemetry setting
	 * @param newSetting The new telemetry setting
	 */
	public captureTelemetrySettingsChanged(previousSetting: TelemetrySetting, newSetting: TelemetrySetting): void {
		this.captureEvent(TelemetryEventName.TELEMETRY_SETTINGS_CHANGED, {
			previousSetting,
			newSetting,
		})
	}

	/**
	 * Checks if telemetry is currently enabled
	 * @returns Whether telemetry is enabled
	 */
	public isTelemetryEnabled(): boolean {
		return this.isReady && this.clients.some((client) => client.isTelemetryEnabled())
	}

	public async shutdown(): Promise<void> {
		if (!this.isReady) {
			return
		}

		// Stop accepting new captures immediately, before draining -- otherwise a steady trickle
		// of new calls (e.g. from a teardown-time error handler) could keep pendingClientCalls
		// non-empty indefinitely and the drain loop below would never terminate on its own.
		this.isShuttingDown = true

		// Drain any in-flight capture/captureException calls first, so a client's shutdown()
		// (which flushes its queue) can't run ahead of a capture that hasn't been enqueued yet.
		// Loop rather than a single snapshot: a call already in flight when draining started may
		// itself still be tracked by the time we check again. Bounded by a timeout so a capture
		// stuck on network I/O that never resolves/rejects can't block deactivate() forever --
		// losing that one capture is an acceptable tradeoff against hanging terminal cleanup.
		const drainStart = Date.now()
		while (this.pendingClientCalls.size > 0 && Date.now() - drainStart < SHUTDOWN_PHASE_TIMEOUT_MS) {
			await Promise.race([
				Promise.all(this.pendingClientCalls),
				new Promise((resolve) => setTimeout(resolve, SHUTDOWN_PHASE_TIMEOUT_MS - (Date.now() - drainStart))),
			])
		}

		// Bound client shutdown the same way as the drain above: posthog-node's own shutdown()
		// defaults to a 30s internal timeout when called with no argument (as PostHogTelemetryClient
		// does), and TelemetryClient#shutdown() takes no timeout parameter to pass one through. Racing
		// against our own timer here, instead of just awaiting client.shutdown() directly, keeps
		// deactivate() from blocking for up to 30s on a client that never settles.
		// allSettled, not all: one client rejecting must not stop us from awaiting the others.
		await Promise.race([
			Promise.allSettled(this.clients.map((client) => client.shutdown())),
			new Promise((resolve) => setTimeout(resolve, SHUTDOWN_PHASE_TIMEOUT_MS)),
		])
	}

	private static _instance: TelemetryService | null = null

	static createInstance(clients: TelemetryClient[] = []) {
		if (this._instance) {
			throw new Error("TelemetryService instance already created")
		}

		this._instance = new TelemetryService(clients)
		return this._instance
	}

	static get instance() {
		if (!this._instance) {
			throw new Error("TelemetryService not initialized")
		}

		return this._instance
	}

	static hasInstance(): boolean {
		return this._instance !== null
	}
}
