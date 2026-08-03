// src/services/stats/UsageStatsStreamCoordinator.ts
//
// Sub-task 4: Demand-driven host stream coordinator.
//
// Manages dashboard stats subscriptions, coalesces event notifications,
// drains bounded batches from the SQLite database, computes deltas via
// applyEventToProjection(), and delivers them to active subscribers.
//
// Design principles (architecture report section 5.15-5.17, lines 353-369):
// - Coordinator depends on a narrow StatsStreamSink interface, NOT ClineProvider
// - Notification only schedules indexed drains; it never carries uncommitted data
// - Coalescing: 50-100 ms batch window under activity
// - Bounded drain: max 100 events / 64 KiB per batch
// - Gap detection: if subscriber's lastSequence has a gap, sends full snapshot
// - Rollover: midnight/DST boundary replaces affected rolling snapshots
// - Reset: clear generation sends reset snapshot to all subscribers
// - Disposal: releases all subscriptions

import type {
	ExtensionMessage,
	DashboardStatsSubscription,
	DashboardStatsSnapshot,
	DashboardStatsDelta,
	DashboardTaskStatsDelta,
	DashboardTaskStatsSnapshot,
	DashboardStatsError,
	UsageEventV1,
	StatsQuery,
} from "@roo-code/types"

import type { UsageStatsDatabase } from "./UsageStatsDatabase"
import {
	assembleRollupSnapshot,
	computeSessionPage,
	computeHeatmapSnapshot,
	applyEventToProjection,
} from "./UsageStatsProjection"
import { computeTaskPage, computeTaskSummaries } from "./DashboardTaskProjection"
import type { DashboardTaskCatalog } from "./DashboardTaskCatalog"
import { resolveTimeRange } from "./UsageAggregator"
import { resolveStatsQueryRangeMs } from "./statsQueryRange"

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Coordinator error codes.
 * Format: STATS_STREAM/function/NNN
 */
export type StatsStreamErrorCode =
	| "STATS_STREAM/subscribe/001" // Database not available
	| "STATS_STREAM/subscribe/002" // Snapshot assembly failed
	| "STATS_STREAM/drain/001" // Drain read failed
	| "STATS_STREAM/drain/002" // Delta computation failed
	| "STATS_STREAM/resume/001" // Resume snapshot failed
	| "STATS_STREAM/rollover/001" // Rollover snapshot failed
	| "STATS_STREAM/reset/001" // Reset snapshot failed

// ── Sink Interface ──────────────────────────────────────────────────────────

/**
 * Narrow message-sink interface so coordinator tests do not construct ClineProvider.
 * The host implements this adapter around postMessageToWebview + visibility check.
 */
export interface StatsStreamSink {
	postMessage(message: ExtensionMessage): void
	isVisible(): boolean
}

// ── Subscription State ──────────────────────────────────────────────────────

/**
 * Internal state for a single subscriber.
 */
interface SubscriptionState {
	/** The sink to deliver messages to. */
	sink: StatsStreamSink
	/** The active subscription (query, heatmap range, session page size). */
	subscription: DashboardStatsSubscription
	/** Last sequence number acknowledged by the subscriber (cursor). */
	lastSequence: number
	/** Current store generation the subscriber is tracking. */
	generation: number
	/** Whether the subscriber is paused (stops delta delivery, retains cursor). */
	paused: boolean
	/** Whether the subscriber has received its initial snapshot. */
	snapshotSent: boolean
	/** Task IDs currently represented by this subscriber's snapshot page. */
	visibleTaskIds: ReadonlySet<string>
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum events per drain batch. */
const MAX_BATCH_EVENTS = 100

/** Maximum serialized size per drain batch (64 KiB). */
const MAX_BATCH_BYTES = 64 * 1024

/** Coalescing window in milliseconds (50 ms). */
const COALESCE_MS = 50

/** Maximum coalescing delay before forced flush (100 ms). */
const MAX_COALESCE_MS = 100

/** Coalesces catalog changes into one replacement snapshot per mutation burst. */
const CATALOG_SNAPSHOT_DEBOUNCE_MS = 50

/** Rollover check interval in milliseconds (checks every 30 seconds). */
const ROLLOVER_CHECK_MS = 30_000

// ── UsageStatsStreamCoordinator ─────────────────────────────────────────────

/**
 * Demand-driven host stream coordinator for dashboard stats.
 *
 * Lifecycle:
 * 1. subscribe() — sends initial snapshot, registers for deltas
 * 2. notifyEventAppended() — schedules a coalesced indexed drain
 * 3. drain() — reads unseen sequences from DB, computes deltas, sends to active subscribers
 * 4. pause/resume — stops/restarts delta delivery, retains cursor
 * 5. replaceSubscription — new epoch, replaces snapshot
 * 6. unsubscribe — releases subscription
 * 7. dispose — releases all subscriptions
 */
export class UsageStatsStreamCoordinator {
	/** Active subscriptions keyed by sink identity (object reference). */
	private readonly subscriptions: Map<StatsStreamSink, SubscriptionState> = new Map()

	/** Pending drain timer (coalescing). */
	private drainTimer: ReturnType<typeof setTimeout> | null = null

	/** Pending full replacement snapshot after a catalog revision. */
	private catalogSnapshotTimer: ReturnType<typeof setTimeout> | null = null

	/** First notification timestamp in the current coalescing window. */
	private coalesceWindowStart: number = 0

	/** Rollover check timer. */
	private rolloverTimer: ReturnType<typeof setInterval> | null = null

	/** Last day bucket seen for rollover detection. */
	private lastDayBucket: string = ""

	/** Whether the coordinator has been disposed. */
	private disposed = false

	/** Whether rollups have already been auto-rebuilt (one-time check). */
	private rollupsRebuilt = false

	/** Whether an async rebuild is currently in flight (prevents concurrent rebuilds). */
	private rebuildInFlight = false

	/** The database to read from (may be null if not initialized). */
	private readonly database: UsageStatsDatabase | null

	/** Optional recording-paused flag provider. */
	private readonly recordingPausedProvider?: () => boolean

	/** Optional History-first catalog. Undefined preserves legacy stream compatibility. */
	private readonly taskCatalog?: DashboardTaskCatalog

	constructor(
		database: UsageStatsDatabase | null,
		options?: { recordingPaused?: () => boolean; taskCatalog?: DashboardTaskCatalog },
	) {
		this.database = database
		this.recordingPausedProvider = options?.recordingPaused
		this.taskCatalog = options?.taskCatalog

		// Start rollover checker
		this.rolloverTimer = setInterval(() => this.checkRollover(), ROLLOVER_CHECK_MS)
	}

	// ── Public API: Subscribe ─────────────────────────────────────────────

	/**
	 * Subscribes a sink to the dashboard stats stream.
	 * Sends the initial snapshot immediately, then registers for deltas.
	 */
	subscribe(sink: StatsStreamSink, subscription: DashboardStatsSubscription): void {
		if (this.disposed) return

		// If already subscribed, unsubscribe first
		if (this.subscriptions.has(sink)) {
			this.subscriptions.delete(sink)
		}

		const generation = this.database ? this.database.getGeneration() : 1
		const lastSequence = this.database ? this.database.getLastSequence() : 0

		const state: SubscriptionState = {
			sink,
			subscription,
			lastSequence,
			generation,
			paused: false,
			snapshotSent: false,
			visibleTaskIds: new Set(),
		}

		this.subscriptions.set(sink, state)

		// Send initial snapshot
		this.sendSnapshot(state)
	}

	/**
	 * Replaces the active dashboard subscription with a new one.
	 * Starts a new epoch: sends a fresh snapshot for the new query.
	 *
	 * The dashboard stream models a single active subscription. Because callers
	 * (e.g. replaceDashboardStatsSubscription) may pass a NEW sink instance rather
	 * than the previously-subscribed sink, we cannot key removal off sink identity.
	 * Doing so would orphan the prior subscription (leak + duplicate deltas).
	 * Therefore we clear ALL existing subscriptions before subscribing the new sink.
	 */
	replaceSubscription(sink: StatsStreamSink, newSubscription: DashboardStatsSubscription): void {
		if (this.disposed) return

		// Remove any existing subscription(s) regardless of sink identity.
		this.subscriptions.clear()

		// Re-subscribe with new query
		this.subscribe(sink, newSubscription)
	}

	/**
	 * Pauses delta delivery for a sink.
	 * Retains the cursor so resume can continue from where it left off.
	 */
	pause(sink: StatsStreamSink): void {
		const state = this.subscriptions.get(sink)
		if (state) {
			state.paused = true
		}
	}

	/**
	 * Resumes delta delivery for a sink.
	 * If the subscriber's lastSequence has a gap (events were missed),
	 * sends a full snapshot replacement instead of deltas.
	 */
	resume(sink: StatsStreamSink, lastSequence: number): void {
		const state = this.subscriptions.get(sink)
		if (!state) return

		state.paused = false

		if (!this.database) return

		const currentGen = this.database.getGeneration()
		const currentLastSeq = this.database.getLastSequence()

		// If generation changed, send full snapshot
		if (currentGen !== state.generation) {
			state.generation = currentGen
			state.lastSequence = currentLastSeq
			this.sendSnapshot(state)
			return
		}

		// Check for gap: if lastSequence is behind the DB's last sequence,
		// we need to drain. If the gap is too large (more than MAX_BATCH_EVENTS
		// events behind), send a full snapshot instead.
		const gap = currentLastSeq - lastSequence
		if (gap > MAX_BATCH_EVENTS) {
			// Gap too large — send full snapshot
			state.lastSequence = currentLastSeq
			this.sendSnapshot(state)
		} else {
			// Small gap — update cursor and schedule a drain
			state.lastSequence = lastSequence
			this.scheduleDrain()
		}
	}

	/**
	 * Unsubscribes a sink, releasing its subscription.
	 */
	unsubscribe(sink: StatsStreamSink): void {
		this.subscriptions.delete(sink)
	}

	/**
	 * Returns the sink's active subscription, when present.
	 * Request/response handlers (task page, task detail) use it to align
	 * one-off reads with the range of the stream subscription.
	 */
	getSubscription(sink: StatsStreamSink): DashboardStatsSubscription | undefined {
		return this.subscriptions.get(sink)?.subscription
	}

	/**
	 * Disposes the coordinator, releasing all subscriptions and timers.
	 */
	dispose(): void {
		this.disposed = true
		this.subscriptions.clear()

		if (this.drainTimer) {
			clearTimeout(this.drainTimer)
			this.drainTimer = null
		}

		if (this.catalogSnapshotTimer) {
			clearTimeout(this.catalogSnapshotTimer)
			this.catalogSnapshotTimer = null
		}

		if (this.rolloverTimer) {
			clearInterval(this.rolloverTimer)
			this.rolloverTimer = null
		}
	}

	// ── Public API: Notification ──────────────────────────────────────────

	/**
	 * Called when a usage event has been appended to the store.
	 * Schedules a coalesced indexed drain. Never carries uncommitted data.
	 */
	notifyEventAppended(_event: UsageEventV1): void {
		if (this.disposed) return
		if (this.subscriptions.size === 0) return

		this.scheduleDrain()
	}

	/**
	 * Called when events were appended externally (cross-window).
	 * Same as notifyEventAppended but without a specific event reference.
	 */
	notifyExternalChange(): void {
		if (this.disposed) return
		if (this.subscriptions.size === 0) return

		this.scheduleDrain()
	}

	/**
	 * Schedules one authoritative page replacement after a History catalog
	 * revision. The catalog cursor embeds the revision, so a replacement prevents
	 * old cursors from mixing rows with the new catalog ordering.
	 */
	notifyTaskCatalogChanged(): void {
		if (this.disposed || this.subscriptions.size === 0 || !this.taskCatalog) return
		if (this.catalogSnapshotTimer) {
			clearTimeout(this.catalogSnapshotTimer)
		}
		this.catalogSnapshotTimer = setTimeout(() => {
			this.catalogSnapshotTimer = null
			for (const state of this.subscriptions.values()) {
				if (!state.paused) {
					this.sendSnapshot(state)
				}
			}
		}, CATALOG_SNAPSHOT_DEBOUNCE_MS)
	}

	/**
	 * Clears the store generation and sends a reset snapshot to all subscribers.
	 */
	resetGeneration(): void {
		if (this.disposed) return
		if (!this.database) return

		const newGeneration = this.database.clearGeneration()

		for (const state of this.subscriptions.values()) {
			state.generation = newGeneration
			state.lastSequence = 0
			this.sendSnapshot(state)
		}
	}

	// ── Internal: Drain ────────────────────────────────────────────────────

	/**
	 * Schedules a coalesced drain. Uses a 50-100 ms batch window.
	 */
	private scheduleDrain(): void {
		const now = Date.now()

		if (this.drainTimer) {
			// If we've been coalescing for too long, force flush
			if (now - this.coalesceWindowStart >= MAX_COALESCE_MS) {
				clearTimeout(this.drainTimer)
				this.drainTimer = null
				this.drain()
				return
			}
			// Otherwise, the existing timer will fire soon
			return
		}

		this.coalesceWindowStart = now
		this.drainTimer = setTimeout(() => {
			this.drainTimer = null
			this.drain()
		}, COALESCE_MS)
	}

	/**
	 * Drains unseen events from the database and sends deltas to active subscribers.
	 * Bounded to MAX_BATCH_EVENTS events and MAX_BATCH_BYTES per batch.
	 */
	private drain(): void {
		if (this.disposed || !this.database) return

		// Collect active (non-paused, snapshot-sent) subscribers
		const activeSubs = Array.from(this.subscriptions.values()).filter((s) => !s.paused && s.snapshotSent)
		if (activeSubs.length === 0) return

		try {
			// Find the minimum lastSequence across active subscribers
			// This is where we start reading from
			const minLastSeq = Math.min(...activeSubs.map((s) => s.lastSequence))

			// Read a bounded batch from the DB
			const batch = this.database.readEventsAfter(minLastSeq, MAX_BATCH_EVENTS)
			if (batch.events.length === 0) return

			// Compute total serialized size for batch limit
			let totalBytes = 0
			const eventsToSend: Array<UsageEventV1 & { sequence: number }> = []

			for (const event of batch.events) {
				const eventSize = JSON.stringify(event).length
				if (eventsToSend.length >= MAX_BATCH_EVENTS || totalBytes + eventSize > MAX_BATCH_BYTES) {
					break
				}
				eventsToSend.push(event)
				totalBytes += eventSize
			}

			if (eventsToSend.length === 0) return

			const lastEventSeq = eventsToSend[eventsToSend.length - 1].sequence

			// For each active subscriber, compute and send deltas
			for (const sub of activeSubs) {
				// Filter events that this subscriber hasn't seen yet
				const unseenEvents = eventsToSend.filter((e) => e.sequence > sub.lastSequence)
				if (unseenEvents.length === 0) continue

				// Check for generation mismatch
				const currentGen = this.database.getGeneration()
				if (currentGen !== sub.generation) {
					// Generation changed — send full snapshot
					sub.generation = currentGen
					sub.lastSequence = this.database.getLastSequence()
					this.sendSnapshot(sub)
					continue
				}

				// Compute deltas for each unseen event
				const deltas: Array<DashboardStatsDelta | DashboardTaskStatsDelta> = []
				// Resolve the subscription range once per drain: task upserts filter
				// membership (task creation ts) and figures (event occurredAt) to it.
				const taskRangeMs = this.taskCatalog ? resolveStatsQueryRangeMs(sub.subscription.range) : undefined
				for (const event of unseenEvents) {
					try {
						const legacyDelta = applyEventToProjection(
							this.database,
							event,
							sub.subscription.range,
							sub.subscription.requestId,
							sub.subscription.heatmapRangeDays,
							sub.generation,
							event.sequence,
						)
						if (this.taskCatalog) {
							const ancestorTaskIds = this.taskCatalog.ancestorsByTaskId.get(event.taskId) ?? []
							const affectedTaskIds = [
								event.taskId,
								...ancestorTaskIds.filter((taskId) => sub.visibleTaskIds.has(taskId)),
							]
							const { sessionUpsert: _sessionUpsert, ...taskDelta } = legacyDelta
							deltas.push({
								...taskDelta,
								taskUpsert: computeTaskSummaries(
									this.taskCatalog,
									this.database,
									affectedTaskIds,
									taskRangeMs,
								),
							})
						} else {
							deltas.push(legacyDelta)
						}
					} catch (err) {
						console.warn(
							`[UsageStatsStreamCoordinator] Failed to compute delta for event ${event.eventId}:`,
							err,
						)
						// On delta computation failure, fall back to snapshot
						sub.lastSequence = this.database.getLastSequence()
						this.sendSnapshot(sub)
						continue
					}
				}

				// Send deltas to the subscriber
				for (const delta of deltas) {
					this.sendDelta(sub, delta)
				}

				// Advance the subscriber's cursor
				sub.lastSequence = Math.max(sub.lastSequence, lastEventSeq)
			}

			// If there are more events to drain, schedule another drain
			if (batch.hasMore) {
				this.scheduleDrain()
			}
		} catch (err) {
			console.warn("[UsageStatsStreamCoordinator] Drain failed:", err)
		}
	}

	// ── Internal: Snapshot ─────────────────────────────────────────────────

	/**
	 * Sends a full snapshot to a subscriber.
	 * Assembles rollup snapshot, session page, and heatmap from the database.
	 *
	 * Non-blocking flow:
	 * 1. Assemble snapshot from whatever data exists (may be empty/stale)
	 * 2. Send snapshot immediately (frontend gets data or empty state quickly)
	 * 3. Check if rebuild is needed (using rollup count, NOT heatmap all-zero)
	 * 4. If rebuild needed, do it asynchronously via setImmediate
	 * 5. After async rebuild completes, re-assemble and send updated snapshot
	 */
	private sendSnapshot(state: SubscriptionState): void {
		if (!this.database) {
			this.sendError(state, "STATS_STREAM/subscribe/001", "Database not available")
			return
		}

		try {
			const query: StatsQuery = state.subscription.range
			const recordingPaused = this.recordingPausedProvider?.() ?? false

			// 1. Assemble the snapshot from whatever data currently exists
			const stats = assembleRollupSnapshot(this.database, query, { recordingPaused })
			const heatmap = computeHeatmapSnapshot(this.database, state.subscription.heatmapRangeDays, query.timezone)

			// 2. Get current generation and sequence
			const generation = this.database.getGeneration()
			const sequence = this.database.getLastSequence()

			const snapshot: DashboardStatsSnapshot | DashboardTaskStatsSnapshot = this.taskCatalog
				? (() => {
						const tasks = computeTaskPage(
							this.taskCatalog!,
							this.database!,
							state.subscription.requestId,
							undefined,
							state.subscription.sessionPageSize,
							resolveStatsQueryRangeMs(state.subscription.range),
						)
						state.visibleTaskIds = new Set(tasks.tasks.map((task) => task.taskId))
						return {
							requestId: state.subscription.requestId,
							generation,
							sequence,
							stats,
							tasks,
							cursor: tasks.cursor,
							heatmap,
						}
					})()
				: (() => {
						const sessions = computeSessionPage(
							this.database!,
							state.subscription.requestId,
							undefined,
							state.subscription.sessionPageSize,
						)
						return {
							requestId: state.subscription.requestId,
							generation,
							sequence,
							stats,
							sessions,
							cursor: sessions.cursor,
							heatmap,
						}
					})()

			state.generation = generation
			state.lastSequence = sequence
			state.snapshotSent = true

			// 3. Send snapshot immediately — frontend gets data or empty state quickly
			this.postMessage(state, {
				type: "dashboardStatsStreamSnapshot",
				dashboardStatsStreamSnapshot: snapshot,
			})

			// 4. Check if async rebuild is needed
			// Use explicit rollup count instead of heatmap all-zero detection,
			// because an inactive user's heatmap is legitimately all-zero.
			if (!this.rollupsRebuilt && !this.rebuildInFlight) {
				const { from, to } = resolveTimeRange(query)
				const fromEpochMs = from ? from.getTime() : 0
				const toEpochMs = to ? to.getTime() : Number.MAX_SAFE_INTEGER
				const coverage = this.database.queryCoverageStats(fromEpochMs, toEpochMs)
				const hasRawEvents = coverage.firstEventAt !== undefined

				if (hasRawEvents) {
					const rollupCount = this.database.getRollupCount()
					const hasEmptyDerivedTables = rollupCount === 0

					if (hasEmptyDerivedTables) {
						// 5. Do the rebuild asynchronously to avoid blocking the event loop
						this.scheduleAsyncRebuild(state)
					} else {
						this.rollupsRebuilt = true
					}
				}
			}
		} catch (err) {
			this.sendError(
				state,
				"STATS_STREAM/subscribe/002",
				`Failed to assemble snapshot: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	/**
	 * Schedules an asynchronous rollup rebuild that does not block the event loop.
	 * After the rebuild completes, re-assembles and sends an updated snapshot
	 * to all active subscribers.
	 *
	 * Uses setImmediate to yield the event loop before the rebuild starts,
	 * allowing pending I/O (including the snapshot postMessage) to flush.
	 */
	private scheduleAsyncRebuild(_triggerState: SubscriptionState): void {
		this.rebuildInFlight = true

		setImmediate(() => {
			try {
				if (this.disposed || !this.database) {
					this.rebuildInFlight = false
					return
				}

				this.database.rebuildRollupsFromEvents()
				this.rollupsRebuilt = true

				// Re-assemble and send updated snapshots to all active subscribers
				for (const state of this.subscriptions.values()) {
					if (state.paused || !state.snapshotSent) continue

					try {
						const query: StatsQuery = state.subscription.range
						const recordingPaused = this.recordingPausedProvider?.() ?? false

						const stats = assembleRollupSnapshot(this.database, query, { recordingPaused })
						const heatmap = computeHeatmapSnapshot(
							this.database,
							state.subscription.heatmapRangeDays,
							query.timezone,
						)

						const generation = this.database.getGeneration()
						const sequence = this.database.getLastSequence()

						const updatedSnapshot: DashboardStatsSnapshot | DashboardTaskStatsSnapshot = this.taskCatalog
							? (() => {
									const tasks = computeTaskPage(
										this.taskCatalog!,
										this.database!,
										state.subscription.requestId,
										undefined,
										state.subscription.sessionPageSize,
										resolveStatsQueryRangeMs(state.subscription.range),
									)
									state.visibleTaskIds = new Set(tasks.tasks.map((task) => task.taskId))
									return {
										requestId: state.subscription.requestId,
										generation,
										sequence,
										stats,
										tasks,
										cursor: tasks.cursor,
										heatmap,
									}
								})()
							: (() => {
									const sessions = computeSessionPage(
										this.database!,
										state.subscription.requestId,
										undefined,
										state.subscription.sessionPageSize,
									)
									return {
										requestId: state.subscription.requestId,
										generation,
										sequence,
										stats,
										sessions,
										cursor: sessions.cursor,
										heatmap,
									}
								})()

						state.generation = generation
						state.lastSequence = sequence

						this.postMessage(state, {
							type: "dashboardStatsStreamSnapshot",
							dashboardStatsStreamSnapshot: updatedSnapshot,
						})
					} catch (err) {
						console.warn("[UsageStatsStreamCoordinator] Failed to send post-rebuild snapshot:", err)
					}
				}
			} catch (err) {
				console.error("[UsageStatsStreamCoordinator] Async rebuild failed:", err)
				// Do NOT latch rollupsRebuilt on failure — allow retry on
				// the next snapshot so transient errors don't permanently
				// disable the rebuild guard.
			} finally {
				this.rebuildInFlight = false
			}
		})
	}

	// ── Internal: Delta Delivery ────────────────────────────────────────────

	/**
	 * Sends a delta message to a subscriber.
	 * If postMessage throws, the subscriber is marked for snapshot fallback.
	 */
	private sendDelta(state: SubscriptionState, delta: DashboardStatsDelta | DashboardTaskStatsDelta): void {
		try {
			this.postMessage(state, {
				type: "dashboardStatsStreamDelta",
				dashboardStatsStreamDelta: delta,
			})
		} catch (err) {
			console.warn(`[UsageStatsStreamCoordinator] postMessage rejected for delta (seq=${delta.sequence}):`, err)
			// Mark for snapshot fallback on next drain
			state.snapshotSent = false
		}
	}

	/**
	 * Sends an error message to a subscriber.
	 */
	private sendError(state: SubscriptionState, code: string, message: string): void {
		const error: DashboardStatsError = {
			requestId: state.subscription.requestId,
			code,
			message,
		}

		try {
			this.postMessage(state, {
				type: "dashboardStatsStreamError",
				dashboardStatsStreamError: error,
			})
		} catch {
			// If even error delivery fails, there's nothing more we can do
		}
	}

	/**
	 * Posts a message to the sink, respecting visibility.
	 * If the sink is not visible, the message is skipped (but cursor still advances).
	 */
	private postMessage(state: SubscriptionState, message: ExtensionMessage): void {
		// Only deliver deltas if the sink is visible
		// Snapshots and errors are always delivered (they're critical)
		if (!state.sink.isVisible() && message.type === "dashboardStatsStreamDelta") {
			return
		}

		state.sink.postMessage(message)
	}

	// ── Internal: Rollover ─────────────────────────────────────────────────

	/**
	 * Checks for midnight/DST boundary crossing.
	 * When the day bucket changes, affected rolling snapshots are replaced
	 * by sending fresh snapshots to all active subscribers.
	 */
	private checkRollover(): void {
		if (this.disposed || !this.database) return
		if (this.subscriptions.size === 0) return

		const now = new Date()
		const dayBucket = now.toISOString().slice(0, 10)

		if (this.lastDayBucket === "") {
			this.lastDayBucket = dayBucket
			return
		}

		if (dayBucket !== this.lastDayBucket) {
			this.lastDayBucket = dayBucket

			// Day boundary crossed — send fresh snapshots to all active subscribers
			for (const state of this.subscriptions.values()) {
				if (!state.paused && state.snapshotSent) {
					try {
						this.sendSnapshot(state)
					} catch (err) {
						console.warn("[UsageStatsStreamCoordinator] Rollover snapshot failed:", err)
					}
				}
			}
		}
	}

	// ── Internal: Utilities ────────────────────────────────────────────────

	/**
	 * Returns the number of active subscriptions.
	 * For testing only.
	 */
	_subscriptionCount(): number {
		return this.subscriptions.size
	}

	/**
	 * Returns whether a drain is pending.
	 * For testing only.
	 */
	_isDrainPending(): boolean {
		return this.drainTimer !== null
	}

	/**
	 * Forces an immediate drain (bypassing coalescing).
	 * For testing only.
	 */
	_forceDrain(): void {
		if (this.drainTimer) {
			clearTimeout(this.drainTimer)
			this.drainTimer = null
		}
		this.drain()
	}
}
