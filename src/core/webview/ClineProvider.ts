import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"
import crypto from "crypto"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import axios from "axios"
import debounce from "lodash.debounce"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type RooCodeSettings,
	type ProviderSettingsEntry,
	type StaticAppProperties,
	type DynamicAppProperties,
	type CloudAppProperties,
	type TaskProperties,
	type GitProperties,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	type PendingTaskAction,
	type CloudUserInfo,
	type CloudOrganizationMembership,
	type CreateTaskOptions,
	type TokenUsage,
	type ToolUsage,
	type ExtensionMessage,
	type ExtensionState,
	type WebviewThemeFixture,
	type MarketplaceInstalledMetadata,
	RooCodeEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_MODES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	getModelId,
	isRetiredProvider,
	providerIdentifiers,
} from "@roo-code/types"
import { RateLimitClock, createRateLimitClock } from "../task/RateLimitClock"
import { TaskRegistry } from "../task/TaskRegistry"
import { TaskScheduler } from "../task/TaskScheduler"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, getRooCodeApiUrl } from "@roo-code/cloud"

import { Package } from "../../shared/package"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { formatLanguage } from "../../shared/language"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { ProfileValidator } from "../../shared/ProfileValidator"

import { Terminal } from "../../integrations/terminal/Terminal"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { MarketplaceManager } from "../../services/marketplace"
import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { CodeIndexManager } from "../../services/code-index/manager"
import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { MdmService } from "../../services/mdm/MdmService"
import { SkillsManager } from "../../services/skills/SkillsManager"

import { fileExistsAtPath } from "../../utils/fs"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { OrganizationAllowListViolationError } from "../../utils/errors"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { buildApiHandler } from "../../api"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { isCompleteTaskHandoffExecutionContext, Task, type TaskHandoffExecutionContext } from "../task/Task"

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { ClineMessage, TodoItem } from "@roo-code/types"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	saveTaskMessages,
	TaskHistoryStore,
	type StrictTaskReadResult,
	abandonDelegatedChild,
	completeDelegatedChild,
	createPreparedProviderHandoffContext,
	classifyProviderHandoffProjectionResults,
	createProviderHandoffPlan,
	createProviderHandoffTransaction,
	decideProviderHandoffProfile,
	delegateTaskToChild,
	getProviderHandoffActivationOptions,
	interruptDelegatedChild,
	publishProviderHandoffState,
	type NamedProviderHandoffProjectionResult,
	type PreparedProviderHandoffContext,
	type ProviderHandoffCommitObservation,
	type ProviderHandoffPolicy,
	type ProviderHandoffProfileIntent,
	type ProviderHandoffProjectionOperation,
	type ProviderHandoffProjectionOutcome,
	type ProviderHandoffTransaction,
} from "../task-persistence"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"
import { PendingEditOperationStore, type PendingEditOperationInput } from "./PendingEditOperationStore"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ClineProviderEvents = {
	clineCreated: [cline: Task]
}

function runDelegationTransition<T>(
	locks: Map<string, Promise<void>>,
	parentTaskId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = locks.get(parentTaskId) ?? Promise.resolve()
	// Fail-forward: run fn even if the previous transition rejected. A failed
	// cancelTask must not permanently block a subsequent reopenParentFromDelegation.
	// The cancelledDelegationChildIds guard inside each fn is the safety net.
	const current = previous.then(fn, fn)
	const tail = current.then(
		() => {},
		() => {},
	)

	locks.set(parentTaskId, tail)

	void tail.finally(() => {
		if (locks.get(parentTaskId) === tail) {
			locks.delete(parentTaskId)
		}
	})

	return current
}

function scheduleTask(scheduler: TaskScheduler, task: Task, source: string): void {
	void scheduler
		.schedule(task, () => task.run())
		.catch((error) => console.error(`[${source}] taskScheduler.schedule failed:`, error))
}

type GetStateOptions = {
	includeTaskHistory?: boolean
}

/**
 * Registration of an in-flight background handoff projection for a child task
 * ID. `token` is an immutable projection identity allocated synchronously when
 * the projection is initiated; every settlement must present the exact token.
 * `admittedGeneration` is bound only when the bounded queue admits the
 * projection and tightens the relevance fence to additionally require that
 * exact generation.
 */
interface ProviderHandoffProjectionTargetRegistration {
	token: number
	admittedGeneration?: number
}

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	private pendingThemeFixtureProbes = new Map<
		string,
		{
			resolve: (fixture: WebviewThemeFixture) => void
			reject: (error: Error) => void
			timeout: ReturnType<typeof setTimeout>
		}
	>()
	private nextThemeFixtureProbeId = 0
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private taskRegistry = new TaskRegistry()
	private taskScheduler = new TaskScheduler()
	private delegationTransitionLocks?: Map<string, Promise<void>>
	private cancelledDelegationChildIds = new Set<string>()
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private marketplaceManager: MarketplaceManager
	private mdmService?: MdmService
	private taskCreationCallback: (task: Task) => void
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()
	private currentWorkspacePath: string | undefined
	private _disposed = false
	private readonly _postStateToWebviewThrottled = debounce(
		async () => {
			try {
				await this.postStateToWebviewWithoutTaskHistory()
			} catch (error) {
				this.log(
					`[ClineProvider#postStateToWebviewThrottled] Failed to post state: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		},
		500,
		{ leading: true, trailing: true, maxWait: 1000 },
	)
	private readonly rateLimitClock: RateLimitClock = createRateLimitClock()

	private recentTasksCache?: string[]
	public readonly taskHistoryStore: TaskHistoryStore
	private taskHistoryStoreInitialized = false
	private globalStateWriteThroughTimer: ReturnType<typeof setTimeout> | null = null
	private static readonly GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS = 5000 // 5 seconds
	public static readonly PENDING_OPERATION_TIMEOUT_MS = 30000 // 30 seconds
	private providerProfileMutationQueue = Promise.resolve()
	private historyTaskCreationQueue = Promise.resolve()
	/**
	 * Live AbortControllers for every queued-or-started profile mutation.
	 * Provider disposal aborts each one so queued-but-not-started callbacks
	 * are cancelled at admission and started callbacks stop before their next
	 * write. Controllers unregister when their operation settles.
	 */
	private profileMutationAbortControllers = new Set<AbortController>()
	/**
	 * Bounded deadline for draining started (non-cancellable) profile writes
	 * during provider disposal. Past the deadline the queue is detached with
	 * handled promises — disposal is never unbounded.
	 */
	private static readonly PROFILE_MUTATION_DISPOSAL_DRAIN_TIMEOUT_MS = 5000
	/**
	 * Monotonic enqueue reservation counter. Every queued operation reserves
	 * the next number when it is enqueued, before it is admitted. Reservations
	 * order the log only: they never gate relevance or supersession, so a
	 * newer reservation that is cancelled before admission (zero writes) can
	 * never supersede an admitted older mutation.
	 */
	private providerProfileMutationReservation = 0
	/**
	 * Monotonic fence for profile mutations, bound ONLY at admission (when the
	 * queue actually invokes the operation). A successfully settled mutation
	 * with this generation supersedes stale handoff projection markers recorded
	 * by older admitted generations. Because the counter advances at admission,
	 * merely enqueuing a newer operation never supersedes an admitted older
	 * projection that is still in flight.
	 */
	private providerProfileMutationGeneration = 0
	/** Admitted generation of the last successfully settled (non-aborted) profile mutation. */
	private providerProfileMutationSettledGeneration = 0

	/**
	 * In-memory marker for a post-commit provider handoff projection that
	 * failed. The committed child's task-local context remains authoritative;
	 * publication derives mode/profile/apiConfiguration from this marker so
	 * partial global writes cannot misreport the child. Never persisted.
	 */
	private staleProviderHandoffProjection?: {
		childTaskId: string
		requestedMode: string
		apiConfigName: string | undefined
		/** Explicit profile projection intent the stale projection was carrying. */
		profileIntent: ProviderHandoffProfileIntent
		apiConfiguration: ProviderSettings
		/**
		 * Admitted mutation generation the marker was recorded under
		 * (supersession fence). `undefined` marks a projection that was never
		 * admitted — it performed zero writes, so its marker is superseded by
		 * any later successful admitted mutation. Never used as a wildcard:
		 * relevance checks compare exact identity, never this value.
		 */
		generation: number | undefined
	}

	/**
	 * In-flight background handoff projections keyed by the prepared child's
	 * task ID, holding the projection's immutable token (plus the admitted
	 * generation once the bounded queue admits it). Registered when the
	 * projection is initiated and dropped by
	 * {@link invalidateProviderHandoffProjectionState} when the child leaves
	 * the provider, so a deferred settlement can never pass the
	 * {@link isProviderHandoffProjectionStillRelevant} fence for a task that
	 * was removed, completed, abandoned, or deleted.
	 */
	private providerHandoffProjectionTargets?: Map<string, ProviderHandoffProjectionTargetRegistration>
	/** Source of immutable projection tokens; incremented synchronously per registration. */
	private nextProviderHandoffProjectionToken = 0

	/**
	 * Children delegated with an explicit profile `clear` intent. While such a
	 * child is current and still carries no sticky profile, publication must
	 * show `undefined` instead of unconditionally falling back to the "default"
	 * profile identity — the absence is an explicit state, not a legacy unset.
	 * In-memory only; bounded by no-profile delegations in this session.
	 */
	private explicitProfileClearChildIds = new Set<string>()

	/**
	 * Completion hook for the most recent background handoff projection.
	 * Deterministic test/observability access: awaiting this promise observes
	 * the projection outcome without polling or sleeps.
	 */
	private providerHandoffProjectionCompletion?: Promise<ProviderHandoffProjectionOutcome>

	/**
	 * Protocol bookkeeping for the delegation in flight, advanced at semantic
	 * landmarks by `delegateParentAndOpenChild`. Purely observational: the
	 * shared reducer never persists anything, never throws into the delegation
	 * flow, and cannot change rollback behavior. Tests read it to verify that
	 * ClineProvider walks the protocol in legal order.
	 */
	private providerHandoffProtocol?: ProviderHandoffTransaction

	/**
	 * The transition owner currently executing under each parent's delegation
	 * lock. The opaque token lets nested same-parent work (restoration/eviction
	 * reached while the lock is already held) prove its reentrancy and run the
	 * unlocked interruption core instead of deadlocking on its own lock.
	 * External callers hold no token and always acquire normally.
	 */
	private delegationTransitionOwners = new Map<string, symbol>()

	private runDelegationTransition<T>(parentTaskId: string, fn: (owner: symbol) => Promise<T>): Promise<T> {
		this.delegationTransitionLocks ??= new Map()
		this.delegationTransitionOwners ??= new Map()
		return runDelegationTransition(this.delegationTransitionLocks, parentTaskId, async () => {
			const owner = Symbol(`delegation-transition:${parentTaskId}`)
			this.delegationTransitionOwners.set(parentTaskId, owner)
			try {
				return await fn(owner)
			} finally {
				if (this.delegationTransitionOwners.get(parentTaskId) === owner) {
					this.delegationTransitionOwners.delete(parentTaskId)
				}
			}
		})
	}

	private enqueueProviderProfileMutation<T>(fn: (signal: AbortSignal, generation: number) => Promise<T>): Promise<T> {
		// Disposal fence: no new profile work is admitted after the provider
		// began shutting down.
		if (this._disposed) {
			return Promise.reject(new Error("Provider profile mutation rejected: provider is disposed"))
		}
		const controller = new AbortController()
		// Reservation (enqueue order) — log identity only. The supersession
		// generation is bound later, at admission, so a newer reservation that
		// never starts cannot fence an admitted older mutation.
		const reservation = ++this.providerProfileMutationReservation
		// Registered so provider disposal can abort this operation whether it
		// is still queued or already started; unregistered when it settles.
		this.profileMutationAbortControllers.add(controller)
		// Admission versus execution: `started` flips synchronously when the
		// queue admits this operation (the previous tail settled and fn began).
		// A timeout before admission is a cancellation — the signal aborts and
		// the generic admission fence below rejects WITHOUT calling fn, so the
		// abandoned callback performs zero writes no matter which caller
		// enqueued it. Once fn has started, the queue tail REMAINS OWNED until
		// the underlying operation settles: storage writes are not
		// cancellable, so releasing the queue would let a newer write
		// interleave with (or physically serialize behind) the still-running
		// older one.
		let started = false
		// Bound when the queue admits the operation; `undefined` while it is
		// still queued (cancelled-before-admission operations never bind one).
		let admittedGeneration: number | undefined
		const runAdmitted = (): Promise<T> => {
			// Generic admission fence, checked centrally for every caller: if
			// this callback was aborted while still queued (caller timeout or
			// provider disposal), it is never invoked at all.
			if (controller.signal.aborted) {
				return Promise.reject(new Error("Provider profile mutation cancelled before admission"))
			}
			started = true
			// The generation is bound HERE, at admission: an operation that is
			// cancelled before admission never consumes a generation, so the
			// supersession fence only moves when a mutation actually starts.
			admittedGeneration = ++this.providerProfileMutationGeneration
			return fn(controller.signal, admittedGeneration)
		}
		const run = this.providerProfileMutationQueue.then(runAdmitted, runAdmitted)
		const previousTail = this.providerProfileMutationQueue
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let fireTimeoutSignal!: () => void
		// Non-rejecting timeout signal: the queue tail must observe the timeout
		// even though the caller-facing promise below sees a rejection.
		const timedOutSignal = new Promise<void>((resolve) => {
			fireTimeoutSignal = resolve
		})
		const timedOut = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				// Abort first: every fn must check its signal before each write,
				// so a timed-out-before-start operation performs no writes and
				// its late completion cannot overwrite newer state.
				controller.abort()
				this.log(
					`Provider profile mutation ${reservation} timed out; the caller is released and later admitted mutations supersede it` +
						(started ? "; the queue stays owned until the started write settles" : ""),
				)
				reject(new Error("Provider profile mutation timed out"))
				fireTimeoutSignal()
			}, ClineProvider.PENDING_OPERATION_TIMEOUT_MS)
		})
		// The caller-facing race consumes the timeout rejection, but a late fire
		// after the caller already settled (or detached) must never surface as
		// an unhandled rejection.
		timedOut.catch(() => {})

		const callerResult = Promise.race([run, timedOut]).finally(() => {
			if (timeoutId) {
				clearTimeout(timeoutId)
			}
		})

		void run.then(
			() => {
				this.profileMutationAbortControllers.delete(controller)
				// Post-dispose completions are inert: no marker supersession or
				// settled-generation bookkeeping once disposal began.
				if (this._disposed) {
					return
				}
				if (controller.signal.aborted) {
					this.log(`Provider profile mutation ${reservation} completed after cancellation`)
					return
				}
				// Admission-generation fence: a successful ADMITTED mutation
				// supersedes any stale handoff projection marker recorded by an
				// older admitted generation. A mutation cancelled before
				// admission never settles here with a generation, so it can
				// never supersede anything.
				if (admittedGeneration === undefined) {
					return
				}
				this.providerProfileMutationSettledGeneration = admittedGeneration
				this.supersedeStaleProviderHandoffProjection(admittedGeneration)
			},
			(error) => {
				this.profileMutationAbortControllers.delete(controller)
				if (controller.signal.aborted) {
					this.log(
						`Provider profile mutation ${reservation} errored after cancellation: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			},
		)

		// Queue-tail ownership with an admission fence: the tail advances when
		// the operation settles, or when the timeout fires BEFORE fn started
		// (admission timeout — cancel-before-start, zero writes). If fn already
		// started when the timeout fires, the tail remains owned by the
		// in-flight underlying write: non-cancellable storage means later
		// profile writes stay serialized behind it instead of overtaking it.
		// An admission abort advances the tail to the PREVIOUS tail, so later
		// operations still wait for every earlier started write. The caller
		// timeout is a liveness guarantee for callers, not for the queue.
		const settled = run.then(
			() => undefined,
			() => undefined,
		)
		this.providerProfileMutationQueue = Promise.race([
			settled,
			timedOutSignal.then(() => (started ? settled : previousTail)),
		])
		return callerResult
	}

	/**
	 * Bounded disposal of the profile-mutation queue (provider shutdown):
	 *
	 * - every queued-but-not-started callback is cancelled at admission (its
	 *   controller is aborted; the central admission fence ensures it never
	 *   runs and performs zero writes);
	 * - started non-cancellable writes are awaited only until
	 *   {@link PROFILE_MUTATION_DISPOSAL_DRAIN_TIMEOUT_MS}, then the queue is
	 *   detached with handled promises — disposal is never unbounded;
	 * - post-dispose completions update no markers and emit no events.
	 */
	private async disposeProviderProfileMutationQueue(): Promise<void> {
		// Self-contained disposal fence: enqueues after this point are
		// rejected and post-dispose completions become inert. (The provider's
		// dispose() sets this flag earlier as well; setting it here keeps the
		// queue-disposal contract true on its own.)
		this._disposed = true
		for (const controller of this.profileMutationAbortControllers) {
			controller.abort()
		}
		this.profileMutationAbortControllers.clear()

		const drained = this.providerProfileMutationQueue.then(
			() => undefined,
			() => undefined,
		)
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let detached = false
		const deadline = new Promise<void>((resolve) => {
			timeoutId = setTimeout(() => {
				detached = true
				resolve()
			}, ClineProvider.PROFILE_MUTATION_DISPOSAL_DRAIN_TIMEOUT_MS)
		})
		await Promise.race([
			drained.then(() => {
				if (timeoutId) {
					clearTimeout(timeoutId)
				}
			}),
			deadline,
		])
		if (detached) {
			this.log(
				`Provider disposal detached a still-running profile mutation after ${ClineProvider.PROFILE_MUTATION_DISPOSAL_DRAIN_TIMEOUT_MS}ms; its late completion is inert`,
			)
		}
	}

	/**
	 * True when `generation` is still the newest ADMITTED profile mutation.
	 * Background projection results may update stale markers or emit events
	 * only while their admission generation is current; a superseded
	 * projection's completion is inert. Because generations are bound at
	 * admission, merely enqueuing a newer operation never makes an admitted
	 * in-flight projection non-current.
	 */
	private isCurrentProfileMutationGeneration(generation: number): boolean {
		return generation === this.providerProfileMutationGeneration
	}

	/**
	 * Allocate the immutable projection identity for a new background handoff
	 * projection and register it as the projection target for `childTaskId`.
	 * Synchronous by contract: the token exists before the bounded queue can
	 * admit or abandon the operation. A later registration for the same task
	 * ID atomically replaces the previous one — the replaced token never
	 * matches again.
	 */
	private registerProviderHandoffProjectionTarget(childTaskId: string): number {
		const token = (this.nextProviderHandoffProjectionToken ?? 0) + 1
		this.nextProviderHandoffProjectionToken = token
		this.providerHandoffProjectionTargets ??= new Map()
		this.providerHandoffProjectionTargets.set(childTaskId, { token })
		return token
	}

	/**
	 * Bind the admitted mutation generation to the registration owning exactly
	 * `token`. A no-op when the registration was replaced or removed: a stale
	 * projection can never re-target or overwrite a newer registration.
	 */
	private admitProviderHandoffProjectionTarget(childTaskId: string, token: number, generation: number): void {
		const registered = this.providerHandoffProjectionTargets?.get(childTaskId)
		if (registered?.token !== token) {
			return
		}
		registered.admittedGeneration = generation
	}

	/**
	 * Central relevance fence for every background handoff projection
	 * completion/failure path, checked before any stale-marker, explicit-clear,
	 * or event update. A settlement presenting `(childTaskId, token,
	 * admittedGeneration)` is relevant only while:
	 *
	 * 1. the provider is not disposed (post-disposal completions are inert);
	 * 2. the child's registered projection target still carries EXACTLY this
	 *    immutable token — a removed registration, or one replaced by a newer
	 *    projection for a reused task ID, never matches; and
	 * 3. after admission, the registered target still carries exactly this
	 *    admitted generation and no newer mutation was admitted. There is no
	 *    generation wildcard: an unadmitted settlement (`admittedGeneration ===
	 *    undefined`) is gated by exact token identity alone.
	 *
	 * A child that is removed, completed, abandoned, or deleted drops its
	 * registration via {@link invalidateProviderHandoffProjectionState} before
	 * its abort is awaited, so a deferred settlement that arrives afterwards is
	 * inert: it must never recreate stale/clear publication state for a task
	 * that is no longer the delegating child.
	 */
	private isProviderHandoffProjectionStillRelevant(
		childTaskId: string,
		token: number,
		admittedGeneration?: number,
	): boolean {
		if (this._disposed) {
			return false
		}
		const registered = this.providerHandoffProjectionTargets?.get(childTaskId)
		if (!registered || registered.token !== token) {
			return false
		}
		if (admittedGeneration === undefined) {
			return true
		}
		return (
			registered.admittedGeneration === admittedGeneration &&
			this.isCurrentProfileMutationGeneration(admittedGeneration)
		)
	}

	/**
	 * Admission-generation fence for the stale handoff projection marker: any
	 * later successful ADMITTED mode/profile mutation supersedes a marker whose
	 * projection never ran (no admitted generation) or ran under an older
	 * generation, so publication can never overlay an outdated child snapshot
	 * after newer profile state was actually committed.
	 */
	private supersedeStaleProviderHandoffProjection(admittedGeneration: number): void {
		const marker = this.staleProviderHandoffProjection
		if (marker && (marker.generation === undefined || marker.generation < admittedGeneration)) {
			this.staleProviderHandoffProjection = undefined
		}
	}

	/**
	 * True when `existing` is strictly newer than the marker about to be
	 * recorded and must be kept. An existing marker with an admitted generation
	 * outranks a never-admitted replacement (zero writes); among admitted
	 * generations the higher one wins.
	 */
	private isStaleMarkerNewerThan(
		existing: { generation: number | undefined },
		admittedGeneration: number | undefined,
	): boolean {
		if (admittedGeneration === undefined) {
			return existing.generation !== undefined
		}
		return existing.generation !== undefined && existing.generation > admittedGeneration
	}

	/** Record a stale handoff projection marker; never overwrites a newer generation's marker. */
	private markStaleProviderHandoffProjection(
		childTaskId: string,
		prepared: Readonly<PreparedProviderHandoffContext>,
		admittedGeneration: number | undefined,
	): void {
		const existing = this.staleProviderHandoffProjection
		if (existing && this.isStaleMarkerNewerThan(existing, admittedGeneration)) {
			return
		}
		this.staleProviderHandoffProjection = {
			childTaskId,
			requestedMode: prepared.requestedMode,
			apiConfigName: prepared.profile.name,
			profileIntent: prepared.profile.intent,
			apiConfiguration: structuredClone(prepared.apiConfiguration),
			generation: admittedGeneration,
		}
		// An explicit no-profile handoff stays explicit even when its legacy
		// projection could not complete: publication must show undefined for
		// this child, never a defaulted profile identity.
		if (prepared.profile.intent.kind === "clear") {
			this.explicitProfileClearChildIds.add(childTaskId)
		}
	}

	/** Clear this generation's (or an older, or never-admitted) stale marker; a newer marker stays authoritative. */
	private clearStaleProviderHandoffProjection(admittedGeneration: number): void {
		const marker = this.staleProviderHandoffProjection
		if (marker && (marker.generation === undefined || marker.generation <= admittedGeneration)) {
			this.staleProviderHandoffProjection = undefined
		}
	}

	/**
	 * True when an explicit profile `clear` is in force for the current task:
	 * either the current child was delegated with a no-profile intent and still
	 * carries no sticky profile, or a stale failed projection carrying a clear
	 * intent still fences publication for the current child. In both cases
	 * `getState`/`getStateToPostToWebview` must publish `undefined` instead of
	 * unconditionally falling back to the "default" identity; ordinary legacy
	 * behavior (no explicit clear) is unchanged.
	 */
	private async isExplicitProfileClearInForce(currentTaskId: string | undefined): Promise<boolean> {
		if (!currentTaskId) return false
		if (this.explicitProfileClearChildIds.has(currentTaskId)) {
			const currentTask = this.getCurrentTask()
			if (currentTask?.taskId === currentTaskId && currentTask.taskApiConfigName !== undefined) {
				// A later explicit profile choice on the child ends the clear.
				this.explicitProfileClearChildIds.delete(currentTaskId)
				return false
			}
			return true
		}
		// A stale clear-intent marker fences publication until a successful
		// ADMITTED mutation supersedes it: the supersession fence clears the
		// marker in place on every successful settlement, so its mere presence
		// here means no admitted mutation has superseded it.
		const marker = this.staleProviderHandoffProjection
		if (marker?.childTaskId === currentTaskId && marker.profileIntent.kind === "clear") {
			return true
		}
		// Durable reconstruction (provider reload): the in-memory sets above
		// are empty after a reload, but an explicit clear durably removed the
		// profile-store identity and the resumed child still carries no sticky
		// profile. Reconstruct the clear from that durable state instead of
		// falling back to the "default" identity. Only the still-current task
		// is affected, and the read is best-effort: a failed read keeps the
		// ordinary default fallback. Fresh installs carry the seeded "default"
		// identity, so the legacy fallback there is unchanged.
		const currentTask = this.getCurrentTask()
		if (currentTask?.taskId !== currentTaskId || currentTask.taskApiConfigName !== undefined) {
			return false
		}
		const durableIdentity = await this.providerSettingsManager
			.getCurrentProfileName()
			.catch(() => "unreadable" as const)
		return durableIdentity === undefined
	}

	/**
	 * The ONE idempotent terminal invalidation helper for a child task's
	 * in-memory handoff publication state. Every terminal path — stack
	 * removal/eviction, deletion (normal and `deleteTaskFromState` fallback),
	 * delegated completion, ordinary completion (only once the durable history
	 * update has established status `completed`), abandonment, and provider
	 * disposal — must call this exactly at the terminal commit boundary,
	 * synchronously before any await or state post. It drops, for this child only:
	 *
	 * 1. the explicit profile `clear` bookkeeping entry,
	 * 2. the background projection-target registration (the immutable token is
	 *    gone, so any deferred settlement — including one already admitted and
	 *    in flight — fails the {@link isProviderHandoffProjectionStillRelevant}
	 *    fence and can never resurrect stale/clear state), and
	 * 3. a stale handoff projection marker recorded for this child.
	 *
	 * The call is safe to repeat and to call for unknown task IDs: every step
	 * is a bounded, side-effect-free removal.
	 */
	private invalidateProviderHandoffProjectionState(childTaskId: string): void {
		this.explicitProfileClearChildIds.delete(childTaskId)
		this.providerHandoffProjectionTargets?.delete(childTaskId)
		const marker = this.staleProviderHandoffProjection
		if (marker?.childTaskId === childTaskId) {
			this.staleProviderHandoffProjection = undefined
		}
	}

	private readonly pendingEditOperations: PendingEditOperationStore

	private cloudOrganizationsCache: CloudOrganizationMembership[] | null = null
	private cloudOrganizationsCacheTimestamp: number | null = null
	private static readonly CLOUD_ORGANIZATIONS_CACHE_DURATION_MS = 5 * 1000 // 5 seconds

	/**
	 * Monotonically increasing sequence number for clineMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private clineMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "sep-2026-v3.82.0-gateway-portability-free-models" // v3.82.0 portable Zoo Gateway keys, free MiniMax-M3, and new models
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
		mdmService?: MdmService,
	) {
		super()
		this.currentWorkspacePath = getWorkspacePath()
		this.pendingEditOperations = new PendingEditOperationStore(
			ClineProvider.PENDING_OPERATION_TIMEOUT_MS,
			(message) => this.log(message),
		)

		ClineProvider.activeInstances.add(this)

		this.mdmService = mdmService
		void this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Initialize the per-task file-based history store.
		// The globalState write-through is debounced separately (not on every mutation)
		// since per-task files are authoritative and globalState is only for downgrade compat.
		this.taskHistoryStore = new TaskHistoryStore(this.contextProxy.globalStorageUri.fsPath, {
			onWrite: async () => {
				this.scheduleGlobalStateWriteThrough()
			},
		})
		this.initializeTaskHistoryStore().catch((error) => {
			this.log(`Failed to initialize TaskHistoryStore: ${error}`)
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				this.mcpHub = hub
				this.mcpHub.registerClient()
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		this.marketplaceManager = new MarketplaceManager(this.context, this.customModesManager)

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(RooCodeEventName.TaskCreated, instance)

			// Create named listener functions so we can remove them later.
			const onTaskStarted = () => this.emit(RooCodeEventName.TaskStarted, instance.taskId)
			const onTaskCompleted = async (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				// Explicitly transition the task to "completed" so that any prior terminal
				// status (e.g. "interrupted" from a previous cancel) is correctly overwritten.
				// saveClineMessages() omits the status field for top-level tasks, which causes
				// the store's merge to preserve a stale "interrupted" status after completion.
				// interrupted → completed is a valid VALID_TRANSITIONS path.
				let completedDurably = false
				try {
					const existing = this.taskHistoryStore.get(taskId)
					if (existing && existing.status !== "completed") {
						await this.updateTaskHistory({ ...existing, status: "completed" })
					}
					// Terminal commit boundary: only a durable completed record for
					// this exact task drops its in-memory handoff publication state.
					// A rejected write or a missing record keeps the projection
					// registration (and any marker/explicit-clear state) alive, so an
					// in-flight deferred settlement stays relevant.
					completedDurably = this.taskHistoryStore.get(taskId)?.status === "completed"
				} catch (err) {
					this.log(
						`[onTaskCompleted] Failed to write completed status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
				if (completedDurably) {
					// Synchronously before the completion/publication events: a
					// TaskCompleted listener can publish state derived from the
					// projection bookkeeping, and any deferred settlement that
					// settles after this point must fail the relevance fence
					// instead of resurrecting stale or explicit-clear state.
					this.invalidateProviderHandoffProjectionState(taskId)
				}
				this.emit(RooCodeEventName.TaskCompleted, taskId, tokenUsage, toolUsage)
			}
			const onTaskAborted = async () => {
				this.emit(RooCodeEventName.TaskAborted, instance.taskId)

				try {
					// Only rehydrate on genuine streaming failures.
					// User-initiated cancels are handled by cancelTask().
					if (instance.abortReason === "streaming_failed") {
						// Defensive safeguard: if another path already replaced this instance, skip
						const current = this.getCurrentTask()
						if (current && current.instanceId !== instance.instanceId) {
							this.log(
								`[onTaskAborted] Skipping rehydrate: current instance ${current.instanceId} != aborted ${instance.instanceId}`,
							)
							return
						}

						const { historyItem } = await this.getTaskWithId(instance.taskId)
						const rootTask = instance.rootTask
						const parentTask = instance.parentTask
						await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
					}
				} catch (error) {
					this.log(
						`[onTaskAborted] Failed to rehydrate after streaming failure: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}
			const onTaskFocused = () => this.emit(RooCodeEventName.TaskFocused, instance.taskId)
			const onTaskUnfocused = () => this.emit(RooCodeEventName.TaskUnfocused, instance.taskId)
			const onTaskActive = (taskId: string) => this.emit(RooCodeEventName.TaskActive, taskId)
			const onTaskInteractive = (taskId: string) => this.emit(RooCodeEventName.TaskInteractive, taskId)
			const onTaskResumable = (taskId: string) => this.emit(RooCodeEventName.TaskResumable, taskId)
			const onTaskIdle = (taskId: string) => this.emit(RooCodeEventName.TaskIdle, taskId)
			const onTaskPaused = (taskId: string) => this.emit(RooCodeEventName.TaskPaused, taskId)
			const onTaskUnpaused = (taskId: string) => this.emit(RooCodeEventName.TaskUnpaused, taskId)
			const onTaskSpawned = (taskId: string) => this.emit(RooCodeEventName.TaskSpawned, taskId)
			const onTaskUserMessage = (taskId: string) => this.emit(RooCodeEventName.TaskUserMessage, taskId)
			const onTaskTokenUsageUpdated = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) =>
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, taskId, tokenUsage, toolUsage)

			// Attach the listeners.
			instance.on(RooCodeEventName.TaskStarted, onTaskStarted)
			instance.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
			instance.on(RooCodeEventName.TaskAborted, onTaskAborted)
			instance.on(RooCodeEventName.TaskFocused, onTaskFocused)
			instance.on(RooCodeEventName.TaskUnfocused, onTaskUnfocused)
			instance.on(RooCodeEventName.TaskActive, onTaskActive)
			instance.on(RooCodeEventName.TaskInteractive, onTaskInteractive)
			instance.on(RooCodeEventName.TaskResumable, onTaskResumable)
			instance.on(RooCodeEventName.TaskIdle, onTaskIdle)
			instance.on(RooCodeEventName.TaskPaused, onTaskPaused)
			instance.on(RooCodeEventName.TaskUnpaused, onTaskUnpaused)
			instance.on(RooCodeEventName.TaskSpawned, onTaskSpawned)
			instance.on(RooCodeEventName.TaskUserMessage, onTaskUserMessage)
			instance.on(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated)

			// Store the cleanup functions for later removal.
			this.taskEventListeners.set(instance, [
				() => instance.off(RooCodeEventName.TaskStarted, onTaskStarted),
				() => instance.off(RooCodeEventName.TaskCompleted, onTaskCompleted),
				() => instance.off(RooCodeEventName.TaskAborted, onTaskAborted),
				() => instance.off(RooCodeEventName.TaskFocused, onTaskFocused),
				() => instance.off(RooCodeEventName.TaskUnfocused, onTaskUnfocused),
				() => instance.off(RooCodeEventName.TaskActive, onTaskActive),
				() => instance.off(RooCodeEventName.TaskInteractive, onTaskInteractive),
				() => instance.off(RooCodeEventName.TaskResumable, onTaskResumable),
				() => instance.off(RooCodeEventName.TaskIdle, onTaskIdle),
				() => instance.off(RooCodeEventName.TaskUserMessage, onTaskUserMessage),
				() => instance.off(RooCodeEventName.TaskPaused, onTaskPaused),
				() => instance.off(RooCodeEventName.TaskUnpaused, onTaskUnpaused),
				() => instance.off(RooCodeEventName.TaskSpawned, onTaskSpawned),
				() => instance.off(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated),
			])
		}
	}

	/**
	 * Initialize the TaskHistoryStore and migrate from globalState if needed.
	 */
	private async initializeTaskHistoryStore(): Promise<void> {
		try {
			await this.taskHistoryStore.initialize()

			// Migration: backfill per-task files from globalState on first run
			const migrationKey = "taskHistoryMigratedToFiles"
			const alreadyMigrated = this.context.globalState.get<boolean>(migrationKey)

			if (!alreadyMigrated) {
				const legacyHistory = this.context.globalState.get<HistoryItem[]>("taskHistory") ?? []

				if (legacyHistory.length > 0) {
					this.log(`[initializeTaskHistoryStore] Migrating ${legacyHistory.length} entries from globalState`)
					await this.taskHistoryStore.migrateFromGlobalState(legacyHistory)
				}

				await this.context.globalState.update(migrationKey, true)
				this.log("[initializeTaskHistoryStore] Migration complete")
			}

			this.taskHistoryStoreInitialized = true
		} catch (error) {
			this.log(`[initializeTaskHistoryStore] Error: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	/**
	 * Initialize cloud profile synchronization
	 */
	private async initializeCloudProfileSync() {
		this.log("Cloud profile synchronization is disabled in compatibility mode")
	}

	/**
	 * Handle cloud settings updates
	 */
	private handleCloudSettingsUpdate = async () => {
		this.log("Ignoring cloud settings update because cloud profile synchronization is disabled")
	}

	/**
	 * Synchronize cloud profiles with local profiles.
	 */
	private async syncCloudProfiles() {
		this.log("Skipping cloud profile synchronization because it is disabled")
	}

	/**
	 * Initialize cloud profile synchronization when CloudService is ready
	 * This method is called externally after CloudService has been initialized
	 */
	public async initializeCloudProfileSyncWhenReady(): Promise<void> {
		this.log("Cloud profile synchronization is disabled in compatibility mode")
	}

	// Adds a new Task instance to the registry, marking the start of a new task.
	// The instance is pushed to the top of the stack (LIFO order).
	// When the task is completed, the top instance is removed, reactivating the
	// previous task.
	async addClineToStack(task: Task) {
		// Add this cline instance into the stack that represents the order of
		// all the called tasks.
		this.taskRegistry.push(task)
		task.emit(RooCodeEventName.TaskFocused)

		// Perform special setup provider specific tasks.
		await this.performPreparationTasks(task)

		// Ensure getState() resolves correctly.
		const state = await this.getState()

		if (!state || typeof state.mode !== "string") {
			throw new Error(t("common:errors.retrieve_current_mode"))
		}
	}

	async performPreparationTasks(cline: Task) {
		// LMStudio: We need to force model loading in order to read its context
		// size; we do it now since we're starting a task with that model selected.
		if (cline.apiConfiguration && cline.apiConfiguration.apiProvider === providerIdentifiers.lmstudio) {
			try {
				if (!hasLoadedFullDetails(cline.apiConfiguration.lmStudioModelId!)) {
					await forceFullModelDetailsLoad(
						cline.apiConfiguration.lmStudioBaseUrl ?? "http://localhost:1234",
						cline.apiConfiguration.lmStudioModelId!,
					)
				}
			} catch (error) {
				this.log(`Failed to load full model details for LM Studio: ${error}`)
				vscode.window.showErrorMessage(error.message)
			}
		}
	}

	// Removes and destroys the top Cline instance (the current finished task),
	// activating the previous one (resuming the parent task).
	async removeClineFromStack() {
		if (this.taskRegistry.length === 0) {
			return
		}

		// Remove the focused Cline instance from the stack.
		let task = this.taskRegistry.current
		if (task) {
			// Terminal invalidation, synchronously before the abort is awaited:
			// a removed task can never be the publication target again.
			this.invalidateProviderHandoffProjectionState(task.taskId)
			task = this.taskRegistry.remove(task.taskId)
		}

		if (task) {
			task.emit(RooCodeEventName.TaskUnfocused)

			try {
				// Abort the running task and set isAbandoned to true so
				// all running promises will exit as well.
				await task.abortTask(true)
			} catch (e) {
				this.log(
					`[ClineProvider#removeClineFromStack] abortTask() failed ${task.taskId}.${task.instanceId}: ${e.message}`,
				)
			}

			// Remove event listeners before clearing the reference.
			const cleanupFunctions = this.taskEventListeners.get(task)

			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(task)
			}

			// Make sure no reference kept, once promises end it will be
			// garbage collected.
			task = undefined
		}
	}

	/**
	 * Evicts the current task from the stack and, if it was an active delegated child,
	 * marks it interrupted so the parent stays delegated (rather than silently losing the link).
	 *
	 * Use this in place of bare removeClineFromStack() at any call site that is not itself
	 * part of a delegation transition (i.e. everywhere except delegateParentAndOpenChild,
	 * createTask with a parentTask, and reopenParentFromDelegation).
	 */
	public async evictCurrentTask(transitionOwner?: symbol): Promise<void> {
		const current = this.getCurrentTask()
		const storedHistory = current ? this.taskHistoryStore.get(current.taskId) : undefined
		await this.removeClineFromStack()
		if (storedHistory?.status === "active" && storedHistory.parentTaskId) {
			await this.markDelegatedChildInterrupted({
				childTaskId: storedHistory.id,
				parentTaskId: storedHistory.parentTaskId,
				transitionOwner,
			})
		}
	}

	/**
	 * Marks a live delegated child as "interrupted" when it is evicted without completing
	 * (e.g. user hits + for a new task, or navigates away while the child is still active).
	 *
	 * This preserves the delegation link — the parent stays "delegated" with awaitingChildId
	 * intact — so the user can later resume or abandon the interrupted child. It is the live-
	 * eviction counterpart to cancelTask()'s interruption path and to reopenParentFromDelegation()
	 * (which handles normal child completion).
	 *
	 * Must be called AFTER removeClineFromStack() so the live Task's final saveClineMessages()
	 * does not reattach the child's parentTaskId/rootTaskId over the interrupted status.
	 */
	/**
	 * Locked wrapper for the interruption transition. When the caller already
	 * owns this parent's transition lock (an opaque owner token acquired from
	 * inside `runDelegationTransition` — restoration/eviction nesting), the
	 * unlocked core runs directly; the lock is never re-acquired for the same
	 * parent. Any other caller — including a different parent's transition —
	 * acquires the lock normally, so ordinary external eviction serialization
	 * is preserved.
	 */
	private async markDelegatedChildInterrupted({
		childTaskId,
		parentTaskId,
		transitionOwner,
	}: {
		childTaskId: string
		parentTaskId: string
		transitionOwner?: symbol
	}): Promise<void> {
		try {
			if (
				transitionOwner !== undefined &&
				this.delegationTransitionOwners.get(parentTaskId) === transitionOwner
			) {
				await this.markDelegatedChildInterruptedUnlocked({ childTaskId, parentTaskId })
				return
			}
			await this.runDelegationTransition(parentTaskId, () =>
				this.markDelegatedChildInterruptedUnlocked({ childTaskId, parentTaskId }),
			)
		} catch (err) {
			this.log(
				`[markDelegatedChildInterrupted] Failed for child ${childTaskId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	/** Unlocked interruption core; requires the parent transition lock (or its reentrant owner). */
	private async markDelegatedChildInterruptedUnlocked({
		childTaskId,
		parentTaskId,
	}: {
		childTaskId: string
		parentTaskId: string
	}): Promise<void> {
		// Fast path: already interrupted (cancelTask beat us to it), nothing to do.
		if (this.taskHistoryStore.get(childTaskId)?.status === "interrupted") {
			this.log(`[markDelegatedChildInterrupted] Child ${childTaskId} already interrupted — skipping`)
			return
		}

		try {
			{
				const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

				if (parentHistory?.status !== "delegated" || parentHistory?.awaitingChildId !== childTaskId) {
					this.log(
						`[markDelegatedChildInterrupted] Parent ${parentTaskId} no longer delegated to child ${childTaskId} — skipping`,
					)
					return
				}

				// Prefer the in-memory store entry: it is written by delegateParentAndOpenChild
				// with the correct parentTaskId before the child saves its first message.
				// getTaskWithId reads from disk and may return an incomplete record (missing
				// parentTaskId) if the child was evicted before its first saveClineMessages().
				const childHistory =
					this.taskHistoryStore.get(childTaskId) ?? (await this.getTaskWithId(childTaskId)).historyItem

				// Re-check inside the lock to close the TOCTOU window with cancelTask() or
				// a concurrent completion. Only proceed when the child is still "active";
				// any other terminal status (interrupted, completed) must not be overwritten.
				if (childHistory?.status !== "active") {
					this.log(
						`[markDelegatedChildInterrupted] Child ${childTaskId} is no longer active (status=${childHistory?.status}) — skipping`,
					)
					return
				}

				const interruptedChild = interruptDelegatedChild(parentHistory, childHistory)
				await this.updateTaskHistory(interruptedChild)
				await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: interruptedChild })
				await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: parentHistory })
				this.log(
					`[markDelegatedChildInterrupted] Marked child ${childTaskId} interrupted; parent ${parentTaskId} stays delegated`,
				)
			}
		} catch (err) {
			this.log(
				`[markDelegatedChildInterrupted] Failed for child ${childTaskId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	getTaskStackSize(): number {
		return this.taskRegistry.length
	}

	public getCurrentTaskStack(): string[] {
		return this.taskRegistry.taskIds
	}

	public async setPendingTaskAction(taskId: string, pendingAction: PendingTaskAction): Promise<void> {
		await this.taskHistoryStore.atomicReadAndUpdate(taskId, (historyItem) => ({
			...historyItem,
			pendingAction,
		}))
		this.recentTasksCache = undefined
	}

	public async clearPendingTaskAction(taskId: string, actionId: string): Promise<boolean> {
		let cleared = false
		try {
			await this.taskHistoryStore.atomicReadAndUpdate(taskId, (historyItem) => {
				if (historyItem.pendingAction?.actionId !== actionId) {
					return historyItem
				}

				cleared = true
				return { ...historyItem, pendingAction: undefined }
			})
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === `[TaskHistoryStore] atomicReadAndUpdate: task ${taskId} not found in cache`
			) {
				return false
			}
			throw error
		}
		if (cleared) {
			this.recentTasksCache = undefined
		}
		return cleared
	}

	// Pending Edit Operations Management

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	public setPendingEditOperation(operationId: string, editData: PendingEditOperationInput): void {
		this.pendingEditOperations.set(operationId, editData)
	}

	/**
	 * Gets a pending edit operation by ID
	 */
	private getPendingEditOperation(operationId: string) {
		return this.pendingEditOperations.get(operationId)
	}

	/**
	 * Clears a specific pending edit operation
	 */
	private clearPendingEditOperation(operationId: string): boolean {
		return this.pendingEditOperations.clear(operationId)
	}

	/**
	 * Clears all pending edit operations
	 */
	private clearAllPendingEditOperations(): void {
		this.pendingEditOperations.clearAll()
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		this.rejectPendingThemeFixtureProbes(new Error("Webview was disposed before the theme fixture probe completed"))
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	/** Drain one task's memoized cleanup without preventing the remaining provider shutdown work. */
	private async drainTaskDisposal(task: Task): Promise<void> {
		try {
			await task.dispose()
		} catch (error) {
			this.log(
				`[ClineProvider#dispose] Task cleanup failed for ${task.taskId}.${task.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this._postStateToWebviewThrottled.cancel()
		this.log("Disposing ClineProvider...")

		// Bounded disposal of queued/started profile mutations and background
		// projections: queued callbacks are cancelled at admission (they never
		// run), started writes are awaited only to a bounded deadline, and
		// post-dispose completions update no markers and emit no events.
		await this.disposeProviderProfileMutationQueue()
		// Session-scoped explicit-clear markers, projection-target
		// registrations, and stale markers do not survive the provider.
		this.explicitProfileClearChildIds.clear()
		this.providerHandoffProjectionTargets?.clear()
		this.staleProviderHandoffProjection = undefined

		// Reject any tasks still waiting for a scheduler permit so they don't
		// hold the event loop after the provider is torn down.
		this.taskScheduler.cancelQueued()

		// Clear all tasks from the stack. The first pop goes through evictCurrentTask()
		// so an active delegated child is marked interrupted before the extension shuts down,
		// rather than being left persisted as "active" across the reload.
		if (this.taskRegistry.length > 0) {
			const task = this.taskRegistry.current!
			await this.evictCurrentTask()
			await this.drainTaskDisposal(task)
		}
		while (this.taskRegistry.length > 0) {
			const task = this.taskRegistry.current!
			await this.removeClineFromStack()
			await this.drainTaskDisposal(task)
		}

		this.log("Cleared all tasks")

		// Clear all pending edit operations to prevent memory leaks
		this.clearAllPendingEditOperations()
		this.log("Cleared pending operations")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.clearWebviewResources()

		// Clean up cloud service event listener
		if (CloudService.hasInstance()) {
			CloudService.instance.off("settings-updated", this.handleCloudSettingsUpdate)
		}

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		await this.marketplaceManager?.cleanup()
		this.customModesManager?.dispose()
		this.taskHistoryStore.dispose()
		this.flushGlobalStateWriteThrough()
		this.log("Disposed all disposables")
		ClineProvider.activeInstances.delete(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static getAllInstances(): ClineProvider[] {
		return Array.from(this.activeInstances)
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		let visibleProvider = ClineProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ClineProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		// Check if there is a cline instance in the stack (if this provider has an active task)
		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		try {
			await visibleProvider.createTask(prompt)
		} catch (error) {
			if (error instanceof OrganizationAllowListViolationError) {
				// Errors from terminal commands seem to get swallowed / ignored.
				vscode.window.showErrorMessage(error.message)
			}

			throw error
		}
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView
		const inTabMode = "onDidChangeViewState" in webviewView

		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}

		// Set up webview options with proper resource roots
		const resourceRoots = [this.contextProxy.extensionUri]

		// Add workspace folders to allow access to workspace files
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}

		webviewView.webview.html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development &&
			process.env.ROO_CODE_THEME_FIXTURE_PROBE !== "1"
				? await this.getHMRHtmlContent(webviewView.webview)
				: await this.getHtmlContent(webviewView.webview)

		// Initialize out-of-scope variables that need to receive persistent
		// global state values.
		await this.getState().then(
			({
				terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
				terminalShellIntegrationDisabled = false,
				terminalCommandDelay = 0,
				terminalZshClearEolMark = true,
				terminalZshOhMy = false,
				terminalZshP10k = false,
				terminalPowershellCounter = false,
				terminalZdotdir = false,
				terminalProfile,
				ttsEnabled,
				ttsSpeed,
			}) => {
				Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
				Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
				Terminal.setCommandDelay(terminalCommandDelay)
				Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
				Terminal.setTerminalZshOhMy(terminalZshOhMy)
				Terminal.setTerminalZshP10k(terminalZshP10k)
				Terminal.setPowershellCounter(terminalPowershellCounter)
				Terminal.setTerminalZdotdir(terminalZdotdir)
				Terminal.setTerminalProfile(terminalProfile)
				setTtsEnabled(ttsEnabled ?? false)
				setTtsSpeed(ttsSpeed ?? 1)
			},
		)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received.
		this.setWebviewMessageListener(webviewView.webview)

		// Initialize code index status subscription for the current workspace.
		this.updateCodeIndexStatusSubscription()

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
			this.updateCodeIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		// Listen for when the panel becomes visible.
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView and WebviewPanel have all the same properties except
			// for this visibility listener panel.
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					void this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					void this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(visibilityDisposable)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.log("Disposing ClineProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					// Reset current workspace manager reference when view is disposed
					this.codeIndexManager = undefined
				}
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				// Sends latest theme name to webview
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)

		// If the extension is starting a new session, clear previous task state.
		// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
		const currentTask = this.getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await this.removeClineFromStack()
		}

		// Ensure zoo-gateway profile is seeded for users who signed in before this feature existed.
		// Without this, users with a valid cached token but no zoo-gateway profile would need to
		// re-authenticate to use Zoo Gateway. Fire-and-forget to avoid blocking webview init.
		void this.ensureZooGatewayProfileSeeded().catch((err) => {
			this.log(`[ensureZooGatewayProfileSeeded] Error: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	/**
	 * Seeds the zoo-gateway provider profile for users who have a cached auth token
	 * but no profile (e.g., users who signed in before Zoo Gateway was added), or
	 * who have an empty/imported profile without a token.
	 * Called once per webview init; handleZooCodeCallback is idempotent so repeated calls are safe.
	 */
	private async ensureZooGatewayProfileSeeded(): Promise<void> {
		const { getCachedZooCodeToken, getZooCodeBaseUrl } = await import("../../services/zoo-code-auth")
		const token = getCachedZooCodeToken()
		if (!token) return
		const expectedGatewayBaseUrl = `${getZooCodeBaseUrl()}/api/gateway/v1`

		// Check ALL zoo-gateway profiles — only skip seeding if every profile has the current token.
		// Using .find() would miss stale tokens in duplicate/renamed profiles since handleZooCodeCallback
		// uses .filter() and updates all of them — the early-return guard must match.
		const allProfiles = await this.providerSettingsManager.listConfig()
		const zooGatewayProfiles = allProfiles.filter((p) => p.apiProvider === providerIdentifiers.zooGateway)

		if (zooGatewayProfiles.length === 0) {
			this.log("[ensureZooGatewayProfileSeeded] No zoo-gateway profile found, creating one")
		} else {
			let allUpToDate = true

			for (const entry of zooGatewayProfiles) {
				try {
					const fullProfile = await this.providerSettingsManager.getProfile({ name: entry.name })
					if (
						fullProfile.zooSessionToken !== token ||
						fullProfile.zooGatewayBaseUrl !== expectedGatewayBaseUrl
					) {
						allUpToDate = false
						this.log("[ensureZooGatewayProfileSeeded] Existing zoo-gateway profile is stale, updating")
						break
					}
				} catch {
					allUpToDate = false
					this.log("[ensureZooGatewayProfileSeeded] Failed to read existing profile, will re-seed")
					break
				}
			}

			if (allUpToDate) {
				const { postZooGatewayCredentialsReady } = await import("../../services/zoo-gateway-credentials-sync")
				postZooGatewayCredentialsReady((message) => this.postMessageToWebview(message))
				return
			}
		}

		// User has token but either no profile, some profiles without token, or stale tokens — seed all
		await this.handleZooCodeCallback(token)
	}

	public createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; transitionOwner?: symbol },
	): Promise<Task> {
		// History navigation can arrive concurrently (for example, two rapid
		// showTaskWithId messages). Serialize the full eviction/installation
		// transition so both callers cannot observe the same previous registry
		// state and schedule distinct Task instances for one history item.
		// Fail forward so one rejected restoration does not poison the queue.
		const previous = this.historyTaskCreationQueue ?? Promise.resolve()
		const run = previous.then(
			() => ClineProvider.prototype.createTaskWithHistoryItemUnlocked.call(this, historyItem, options),
			() => ClineProvider.prototype.createTaskWithHistoryItemUnlocked.call(this, historyItem, options),
		)
		this.historyTaskCreationQueue = run.then(
			() => {},
			() => {},
		)
		return run
	}

	private async createTaskWithHistoryItemUnlocked(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; transitionOwner?: symbol },
	): Promise<Task> {
		const isCliRuntime = process.env.ROO_CLI_RUNTIME === "1"
		// CLI injects runtime provider settings from command flags/env at startup.
		// Restoring provider profiles from task history can overwrite those
		// runtime settings with stale/incomplete persisted profiles.
		const skipProfileRestoreFromHistory = isCliRuntime

		// Check if we're rehydrating the current task to avoid flicker
		const currentTask = this.getCurrentTask()
		const isRehydratingCurrentTask = currentTask && currentTask.taskId === historyItem.id

		if (!isRehydratingCurrentTask) {
			// `transitionOwner` proves the caller already owns the evicted
			// child's parent delegation transition (restoration under a held
			// lock); same-parent interruption then runs its unlocked core
			// instead of re-acquiring the lock it already holds.
			await this.evictCurrentTask(options?.transitionOwner)
		}

		// If the history item has a saved mode, restore it and its associated API configuration.
		if (historyItem.mode) {
			// Validate that the mode still exists
			const customModes = await this.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined

			if (!modeExists) {
				// Mode no longer exists, fall back to default mode.
				this.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}

			await this.updateGlobalState("mode", historyItem.mode)

			// Load the saved API config for the restored mode if it exists.
			// Skip mode-based profile activation if historyItem.apiConfigName exists,
			// since the task's specific provider profile will override it anyway.
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)

			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				const savedConfigId = await this.providerSettingsManager.getModeConfigId(historyItem.mode)
				const listApiConfig = await this.providerSettingsManager.listConfig()

				// Update listApiConfigMeta first to ensure UI has latest data.
				await this.updateGlobalState("listApiConfigMeta", listApiConfig)

				// If this mode has a saved config, use it.
				if (savedConfigId) {
					const profile = listApiConfig.find(({ id }) => id === savedConfigId)

					if (profile?.name) {
						try {
							// Check if the profile has actual API configuration (not just an id).
							// In CLI mode, the ProviderSettingsManager may return empty default profiles
							// that only contain 'id' and 'name' fields. Activating such a profile would
							// overwrite the CLI's working API configuration with empty settings.
							const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
							const hasActualSettings = !!fullProfile.apiProvider

							if (hasActualSettings) {
								await this.activateProviderProfile({ name: profile.name })
							} else {
								// The task will continue with the current/default configuration.
							}
						} catch (error) {
							// Log the error but continue with task restoration.
							this.log(
								`Failed to restore API configuration for mode '${historyItem.mode}': ${
									error instanceof Error ? error.message : String(error)
								}. Continuing with default configuration.`,
							)
							// The task will continue with the current/default configuration.
						}
					}
				}
			}
		}

		// If the history item has a saved API config name (provider profile), restore it.
		// This overrides any mode-based config restoration above, because the task's
		// specific provider profile takes precedence over mode defaults.
		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			const listApiConfig = await this.providerSettingsManager.listConfig()
			// Keep global state/UI in sync with latest profiles for parity with mode restoration above.
			await this.updateGlobalState("listApiConfigMeta", listApiConfig)
			const profile = listApiConfig.find(({ name }) => name === historyItem.apiConfigName)

			if (profile?.name) {
				try {
					if (profile.apiProvider) {
						await this.activateProviderProfile(
							{ name: profile.name },
							{ persistModeConfig: false, persistTaskHistory: false },
						)
					}
				} catch (error) {
					// Log the error but continue with task restoration.
					this.log(
						`Failed to restore API configuration '${historyItem.apiConfigName}' for task: ${
							error instanceof Error ? error.message : String(error)
						}. Continuing with current configuration.`,
					)
				}
			} else {
				// Profile no longer exists, log warning but continue
				this.log(
					`Provider profile '${historyItem.apiConfigName}' from history no longer exists. Using current configuration.`,
				)
			}
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			this.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}

		const {
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			experiments,
			cloudUserInfo,
			taskSyncEnabled,
			diffFuzzyThreshold,
		} = await this.getState()

		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: false,
			// Preserve the status from the history item to avoid overwriting it when the task saves messages
			initialStatus: historyItem.status,
			rateLimitClock: this.rateLimitClock,
			diffFuzzyThreshold,
		})

		if (isRehydratingCurrentTask) {
			// Replace the current task in-place to avoid UI flicker
			const oldTask = this.taskRegistry.current

			if (oldTask) {
				// Abort the old task to stop running processes and mark as abandoned
				try {
					await oldTask.abortTask(true)
				} catch (e) {
					this.log(
						`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${e.message}`,
					)
				}

				// Remove event listeners from the old task
				const cleanupFunctions = this.taskEventListeners.get(oldTask)
				if (cleanupFunctions) {
					cleanupFunctions.forEach((cleanup) => cleanup())
					this.taskEventListeners.delete(oldTask)
				}

				// Replace in-place: preserves stack index and current pointer
				this.taskRegistry.replace(oldTask.taskId, task)
			}

			task.emit(RooCodeEventName.TaskFocused)

			// Perform preparation tasks and set up event listeners
			await this.performPreparationTasks(task)

			this.log(
				`[createTaskWithHistoryItem] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`,
			)

			if (options?.startTask !== false) {
				scheduleTask(this.taskScheduler, task, "createTaskWithHistoryItem")
			}
		} else {
			await this.addClineToStack(task)

			this.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)

			if (options?.startTask !== false) {
				scheduleTask(this.taskScheduler, task, "createTaskWithHistoryItem")
			}
		}

		// Check if there's a pending edit after checkpoint restoration
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.getPendingEditOperation(operationId)
		if (pendingEdit) {
			this.clearPendingEditOperation(operationId) // Clear the pending edit

			this.log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)

			// Process the pending edit after a short delay to ensure the task is fully initialized
			setTimeout(async () => {
				try {
					// Find the message index in the restored state
					const { messageIndex, apiConversationHistoryIndex } = (() => {
						const messageIndex = task.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
						const apiConversationHistoryIndex = task.apiConversationHistory.findIndex(
							(msg) => msg.ts === pendingEdit.messageTs,
						)
						return { messageIndex, apiConversationHistoryIndex }
					})()

					if (messageIndex !== -1) {
						// Remove the target message and all subsequent messages
						await task.overwriteClineMessages(task.clineMessages.slice(0, messageIndex))

						if (apiConversationHistoryIndex !== -1) {
							await task.overwriteApiConversationHistory(
								task.apiConversationHistory.slice(0, apiConversationHistoryIndex),
							)
						}

						// Process the edited message
						await task.handleWebviewAskResponse(
							"messageResponse",
							pendingEdit.editedContent,
							pendingEdit.images,
						)
					}
				} catch (error) {
					this.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
				}
			}, 100) // Small delay to ensure task is fully ready
		}

		return task
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	public requestWebviewThemeFixture(timeoutMs = 5_000): Promise<WebviewThemeFixture> {
		if (process.env.ROO_CODE_THEME_FIXTURE_PROBE !== "1") {
			return Promise.reject(new Error("Theme fixture probing is disabled"))
		}

		const requestId = `theme-fixture-${++this.nextThemeFixtureProbeId}`

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingThemeFixtureProbes.delete(requestId)
				reject(new Error(`Theme fixture probe timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			this.pendingThemeFixtureProbes.set(requestId, { resolve, reject, timeout })
			void this.postMessageToWebview({ type: "themeFixtureProbeRequest", requestId })
		})
	}

	public resolveWebviewThemeFixtureProbe(requestId: string, fixture: WebviewThemeFixture): void {
		const pending = this.pendingThemeFixtureProbes.get(requestId)
		if (!pending) {
			return
		}

		clearTimeout(pending.timeout)
		this.pendingThemeFixtureProbes.delete(requestId)
		pending.resolve(fixture)
	}

	private rejectPendingThemeFixtureProbes(error: Error): void {
		for (const pending of this.pendingThemeFixtureProbes.values()) {
			clearTimeout(pending.timeout)
			pending.reject(error)
		}
		this.pendingThemeFixtureProbes.clear()
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				console.log(`[ClineProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				console.log(
					`[ClineProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			console.error("[ClineProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.hmr_not_running"))
			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		const file = "src/index.tsx"
		const scriptUri = `http://${localServerUrl}/${file}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://localhost:${localPort}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com data:`,
			`media-src ${webview.cspSource}`,
			`script-src 'unsafe-eval' ${webview.cspSource} https://*.posthog.com http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} ${openRouterDomain} https://* https://*.posthog.com ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>Zoo Code</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "build", "assets", "index.js"])
		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		// Use a nonce to only allow a specific script to be run.
		/*
		content security policy of your webview to only allow scripts that have a specific nonce
		create a content security policy meta tag so that only loading scripts with a nonce is allowed
		As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

		in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
		*/
		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai https://us.i.posthog.com;">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>Zoo Code</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message, this.marketplaceManager)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 * @param targetTask The task whose in-memory mode should be updated. Defaults to the
	 * current task. Pass null to apply only global mode/profile effects for a pending child.
	 */
	public async handleModeSwitch(
		newMode: Mode,
		targetTask: Task | null | undefined = this.getCurrentTask(),
		options: { pendingHandoff?: ProviderHandoffPolicy } = {},
	) {
		return this.enqueueProviderProfileMutation((signal) =>
			this.handleModeSwitchUnlocked(newMode, targetTask, options, signal),
		)
	}

	private async handleModeSwitchUnlocked(
		newMode: Mode,
		targetTask: Task | null | undefined,
		options: { pendingHandoff?: ProviderHandoffPolicy },
		signal?: AbortSignal,
	): Promise<void> {
		const task = targetTask

		if (task) {
			TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
			task.emit(RooCodeEventName.TaskModeSwitched, task.taskId, newMode)

			try {
				// Update the task history with the new mode first.
				const taskHistoryItem =
					this.taskHistoryStore.get(task.taskId) ??
					(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

				if (taskHistoryItem) {
					await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
				}

				// Only update the task's mode after successful persistence.
				;(task as any)._taskMode = newMode
			} catch (error) {
				// If persistence fails, log the error but don't update the in-memory state.
				this.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)

				// Optionally, we could emit an event to notify about the failure.
				// This ensures the in-memory state remains consistent with persisted state.
				throw error
			}
		}

		const previousMode = options.pendingHandoff ? this.getGlobalState("mode") : undefined

		try {
			await this.updateGlobalState("mode", newMode)

			this.emit(RooCodeEventName.ModeChanged, newMode)

			// If workspace lock is on, keep the current API config — don't load mode-specific config
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
			if (lockApiConfigAcrossModes) {
				await publishProviderHandoffState(targetTask !== null, options.pendingHandoff, () =>
					this.postStateToWebview(),
				)
				return
			}

			if (signal?.aborted) return

			// Load the saved API config for the new mode if it exists.
			const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
			const listApiConfig = await this.providerSettingsManager.listConfig()

			if (signal?.aborted) return

			// Update listApiConfigMeta first to ensure UI has latest data.
			await this.updateGlobalState("listApiConfigMeta", listApiConfig)

			// If this mode has a saved config, use it.
			if (savedConfigId) {
				const profile = listApiConfig.find(({ id }) => id === savedConfigId)

				if (profile?.name) {
					// Check if the profile has actual API configuration (not just an id).
					// In CLI mode, the ProviderSettingsManager may return empty default profiles
					// that only contain 'id' and 'name' fields. Activating such a profile would
					// overwrite the CLI's working API configuration with empty settings.
					// Skip activation if the profile has no apiProvider set - this indicates
					// an unconfigured/empty profile.
					const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
					const hasActualSettings = !!fullProfile.apiProvider

					if (hasActualSettings) {
						const profileName = options.pendingHandoff
							? decideProviderHandoffProfile({
									locked: false,
									savedProfile: { name: profile.name, id: profile.id },
								}).profile.name
							: profile.name
						const activationOptions = options.pendingHandoff
							? getProviderHandoffActivationOptions(options.pendingHandoff)
							: targetTask === null
								? { skipCurrentTaskRebuild: true }
								: undefined
						await this.activateProviderProfileUnlocked({ name: profileName }, activationOptions, signal)
					} else {
						// The task will continue with the current/default configuration.
					}
				} else {
					// The task will continue with the current/default configuration.
				}
			} else {
				// If no saved config for this mode, save current config as default.
				const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")

				const config = listApiConfig.find((candidate) => candidate.name === currentApiConfigNameAfter)
				const configId = options.pendingHandoff
					? decideProviderHandoffProfile({
							locked: false,
							currentProfile: currentApiConfigNameAfter
								? { name: currentApiConfigNameAfter, id: config?.id }
								: undefined,
						}).persistModeProfileId
					: config?.id

				if (configId) {
					await this.providerSettingsManager.setModeConfig(newMode, configId)
				}
			}

			await publishProviderHandoffState(targetTask !== null, options.pendingHandoff, () =>
				this.postStateToWebview(),
			)
		} catch (error) {
			if (options.pendingHandoff) {
				await this.updateGlobalState("mode", previousMode)
				if (previousMode !== undefined) this.emit(RooCodeEventName.ModeChanged, previousMode)
			}
			throw error
		}
	}

	// Provider Profile Management

	/**
	 * Updates the current task's API handler.
	 * Rebuilds when:
	 * - provider or model changes, OR
	 * - explicitly forced (e.g., user-initiated profile switch/save to apply changed settings like headers/baseUrl/tier).
	 * Always synchronizes task.apiConfiguration with latest provider settings.
	 * @param providerSettings The new provider settings to apply
	 * @param options.forceRebuild Force rebuilding the API handler regardless of provider/model equality
	 */
	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean; skipCurrentTaskRebuild?: boolean } = {},
	): void {
		if (options.skipCurrentTaskRebuild) return
		const task = this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			// No rebuild needed, just sync apiConfiguration
			;(task as any).apiConfiguration = providerSettings
		}
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			return await this.enqueueProviderProfileMutation(async (signal) => {
				// TODO: Do we need to be calling `activateProfile`? It's not
				// clear to me what the source of truth should be; in some cases
				// we rely on the `ContextProxy`'s data store and in other cases
				// we rely on the `ProviderSettingsManager`'s data store. It might
				// be simpler to unify these two.
				const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

				if (signal.aborted) return id

				if (activate) {
					const { mode } = await this.getState()

					// These promises do the following:
					// 1. Adds or updates the list of provider profiles.
					// 2. Sets the current provider profile.
					// 3. Sets the current mode's provider profile.
					// 4. Copies the provider settings to the context.
					//
					// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
					// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
					// We should probably switch to that and verify that it works.
					// I left the original implementation in just to be safe.
					await Promise.all([
						this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
						this.updateGlobalState("currentApiConfigName", name),
						this.providerSettingsManager.setModeConfig(mode, id),
						this.contextProxy.setProviderSettings(providerSettings),
					])

					// Change the provider for the current task.
					// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
					this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

					// Keep the current task's sticky provider profile in sync with the newly-activated profile.
					await this.persistStickyProviderProfileToCurrentTask(name)
				} else {
					await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
				}

				await this.postStateToWebview()
				return id
			})
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebview()
	}

	private async persistStickyProviderProfileToCurrentTask(
		apiConfigName: string,
		options: { skipCurrentTaskRebuild?: boolean } = {},
	): Promise<void> {
		if (options.skipCurrentTaskRebuild) return
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)

			const taskHistoryItem =
				this.taskHistoryStore.get(task.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: {
			persistModeConfig?: boolean
			persistTaskHistory?: boolean
			skipCurrentTaskRebuild?: boolean
			applyProviderSettingsToContext?: boolean
			suppressStatePost?: boolean
		},
	) {
		return this.enqueueProviderProfileMutation((signal) =>
			this.activateProviderProfileUnlocked(args, options, signal),
		)
	}

	private async activateProviderProfileUnlocked(
		args: { name: string } | { id: string },
		options?: {
			persistModeConfig?: boolean
			persistTaskHistory?: boolean
			skipCurrentTaskRebuild?: boolean
			applyProviderSettingsToContext?: boolean
			suppressStatePost?: boolean
		},
		signal?: AbortSignal,
	): Promise<void> {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		if (signal?.aborted) return

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true
		const skipCurrentTaskRebuild = options?.skipCurrentTaskRebuild ?? false
		const applyProviderSettingsToContext = options?.applyProviderSettingsToContext ?? !skipCurrentTaskRebuild
		const suppressStatePost = options?.suppressStatePost ?? false

		if (applyProviderSettingsToContext) {
			// See `upsertProviderProfile` for a description of what this is doing.
			await Promise.all([
				this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
				this.contextProxy.setValue("currentApiConfigName", name),
				this.contextProxy.setProviderSettings(providerSettings),
			])
		}

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
		}

		// Change the provider for the current task.
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true, skipCurrentTaskRebuild })

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name, { skipCurrentTaskRebuild })
		}

		if (!skipCurrentTaskRebuild && !suppressStatePost) {
			await this.postStateToWebview()
		}

		if (providerSettings.apiProvider && !skipCurrentTaskRebuild) {
			this.emit(RooCodeEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\Roo-Code\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "Roo-Code", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Cline/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Cline", "MCP")
		} else {
			// Linux: ~/.local/share/Cline/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "Roo-Code", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".roo-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		const { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// Zoo Code Auth

	async handleZooCodeCallback(token: string) {
		// Auth mutation (token storage, subscription check, success toast) was already
		// performed by handleAuthCallback() in handleUri.ts before this method was called.
		// Save the zoo-gateway provider profile with the session token so that
		// ZooGatewayHandler can authenticate without any manual user input.
		//
		// activate: true ONLY if Zoo Gateway is already the active profile — this pushes
		// the new token to the in-memory handler so the current task picks it up immediately.
		// Otherwise activate: false — do NOT switch providers mid-conversation. The user
		// must explicitly select Zoo Gateway in settings if they want to use it.
		try {
			const { apiConfiguration } = await this.getState()
			const currentSettings = this.contextProxy.getProviderSettings()
			const currentApiConfigName = this.contextProxy.getValues().currentApiConfigName

			// Derive the gateway base URL from ZOO_CODE_BASE_URL so that non-prod environments
			// (staging, local dev) route completions to the correct backend instead of always
			// hard-coding production. An already-set value in the profile is NOT preserved here —
			// it must always align with the auth server the user just authenticated against.
			const { getZooCodeBaseUrl } = await import("../../services/zoo-code-auth")
			const derivedGatewayBaseUrl = `${getZooCodeBaseUrl()}/api/gateway/v1`

			// Check if Zoo Gateway is the currently active profile by apiProvider identity,
			// not by profile name (profile names are user-renameable).
			const isZooGatewayActive = currentSettings.apiProvider === providerIdentifiers.zooGateway

			// Always scan ALL profiles and update every zoo-gateway profile with the new token.
			// This ensures renamed profiles, duplicate profiles, and inactive profiles all stay
			// in sync. The model lookup in requestRouterModels uses .find() which returns the
			// first zoo-gateway profile it finds — if that profile has a stale token, requests fail.
			const allProfiles = await this.providerSettingsManager.listConfig()
			const zooProfiles = allProfiles.filter((p) => p.apiProvider === providerIdentifiers.zooGateway)

			if (zooProfiles.length === 0) {
				// No existing zoo-gateway profile — create the canonical default.
				const newConfiguration: ProviderSettings = {
					apiProvider: providerIdentifiers.zooGateway,
					zooSessionToken: token,
					zooGatewayModelId: apiConfiguration.zooGatewayModelId,
					zooGatewayBaseUrl: derivedGatewayBaseUrl,
				}
				// Activate only if zoo-gateway was the active provider (shouldn't happen if
				// no profiles exist, but defensive).
				await this.upsertProviderProfile("Zoo Gateway", newConfiguration, isZooGatewayActive)
			} else {
				// Update every existing zoo-gateway profile with the new token and the
				// derived base URL so that environment-specific routing stays consistent.
				for (const entry of zooProfiles) {
					const isActiveProfile = isZooGatewayActive && entry.name === currentApiConfigName
					const existing = await this.providerSettingsManager.getProfile({ name: entry.name })
					const updated: ProviderSettings = {
						...existing,
						zooSessionToken: token,
						zooGatewayBaseUrl: derivedGatewayBaseUrl,
					}
					if (isActiveProfile) {
						// Use upsertProviderProfile with activate: true so the in-memory handler
						// picks up the new token immediately for the current task.
						await this.upsertProviderProfile(entry.name, updated, true)
					} else {
						// Non-active profiles just need the token saved to disk.
						await this.providerSettingsManager.saveConfig(entry.name, updated)
					}
				}
			}
		} catch (error) {
			this.log(
				`[handleZooCodeCallback] Failed to save zoo-gateway profile: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
		await this.postStateToWebview()
		const { postZooGatewayCredentialsReady } = await import("../../services/zoo-gateway-credentials-sync")
		postZooGatewayCredentialsReady((message) => this.postMessageToWebview(message))
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		const { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: providerIdentifiers.requesty,
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const historyItem =
			this.taskHistoryStore.get(id) ?? (this.getGlobalState("taskHistory") ?? []).find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				console.warn(
					`[getTaskWithId] api_conversation_history.json corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			console.warn(
				`[getTaskWithId] api_conversation_history.json missing for task ${id}, returning empty history`,
			)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			const result = await this.getTaskWithId(id)
			return result.historyItem
		})

		return { historyItem, aggregatedCosts }
	}

	async showTaskWithId(id: string) {
		if (id !== this.getCurrentTask()?.taskId) {
			// Non-current task.
			const { historyItem } = await this.getTaskWithId(id)
			await this.createTaskWithHistoryItem(historyItem) // Clears existing task.
		}

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)
		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadTask(historyItem.ts, apiConversationHistory, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/* Condenses a task's message history to use fewer tokens. */
	async condenseTaskContext(taskId: string) {
		const task = this.taskRegistry.getById(taskId)
		if (!task) {
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		await task.condenseContext()
		await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
	}

	// this function deletes a task from task history, and deletes its checkpoints and delete the task folder
	// If the task has subtasks (childIds), they will also be deleted recursively
	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		try {
			// get the task directory full path and history item
			const { taskDirPath, historyItem } = await this.getTaskWithId(id)

			// Collect all task IDs to delete (parent + all subtasks)
			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				// Recursively collect all child IDs
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch (error) {
						// Child task may already be deleted or not found, continue
						console.log(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Remove from stack if any of the tasks to delete are in the current task stack
			for (const taskId of allIdsToDelete) {
				if (taskId === this.getCurrentTask()?.taskId) {
					// Close the current task instance; delegation flows will be handled via metadata if applicable.
					await this.removeClineFromStack()
					break
				}
			}

			// Delete all tasks from state in one batch
			await this.taskHistoryStore.deleteMany(allIdsToDelete)
			// Terminal invalidation for every deleted id, immediately after the
			// durable delete: a stale child id can never fence publication
			// after deletion.
			for (const taskId of allIdsToDelete) {
				this.invalidateProviderHandoffProjectionState(taskId)
			}
			this.recentTasksCache = undefined

			// Delete associated shadow repositories or branches and task directories
			const globalStorageDir = this.contextProxy.globalStorageUri.fsPath
			const workspaceDir = this.cwd
			const { getTaskDirectoryPath } = await import("../../utils/storage")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to delete associated shadow repository or branch: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Delete the task directory
				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					console.log(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			await this.postStateToWebview()
		} catch (error) {
			// If task is not found, just remove it from state
			if (error instanceof Error && error.message === "Task not found") {
				await this.deleteTaskFromState(id)
				return
			}
			throw error
		}
	}

	async deleteTaskFromState(id: string) {
		// Terminal invalidation FIRST — synchronously, before any await or
		// state post. This is the fallback delete path ("Task not found" in
		// deleteTaskWithId): the durable delete below may reject and the post
		// may never run, so the projection-target registration, explicit-clear
		// bookkeeping, and stale marker must already be gone here. A deferred
		// projection settlement that arrives during or after the delete then
		// fails the exact-token relevance fence and can never resurrect stale
		// or explicit-clear state for the deleted task.
		this.invalidateProviderHandoffProjectionState(id)
		await this.taskHistoryStore.delete(id)
		this.recentTasksCache = undefined

		await this.postStateToWebview()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}

	async postStateToWebview() {
		const clineMessagesSeq = ++this.clineMessagesSeq
		const state = await this.getStateToPostToWebview()
		state.clineMessagesSeq = clineMessagesSeq
		await this.postMessageToWebview({ type: "state", state })
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 *
	 * Rationale:
	 * - taskHistory can be large and was being resent on every chat message update.
	 * - The webview maintains taskHistory in-memory and receives updates via
	 *   `taskHistoryUpdated` / `taskHistoryItemUpdated`.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		const clineMessagesSeq = ++this.clineMessagesSeq
		const state = await this.getStateToPostToWebview({ includeTaskHistory: false })
		state.clineMessagesSeq = clineMessagesSeq
		const { taskHistory: _omit, ...rest } = state
		await this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Schedules a debounced state-post attempt. A call made while the debounce timer is active returns
	 * the result of the most recent invocation, so awaiting this method does not wait for the trailing
	 * invocation scheduled by that call. Use `flushPostStateToWebviewThrottled()` to force and await any
	 * pending trailing invocation before continuing.
	 */
	async postStateToWebviewThrottled(): Promise<void> {
		if (this._disposed) {
			return
		}

		await this._postStateToWebviewThrottled()
	}

	async flushPostStateToWebviewThrottled(): Promise<void> {
		if (this._disposed) {
			return
		}

		await this._postStateToWebviewThrottled.flush()
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 *
	 * Rationale:
	 * - Cloud event handlers (auth, settings, user-info) and mode changes trigger state pushes
	 *   that have nothing to do with chat messages. Including clineMessages in these pushes
	 *   creates race conditions where a stale snapshot of clineMessages (captured during async
	 *   getStateToPostToWebview) overwrites newer messages the task has streamed in the meantime.
	 * - This method ensures cloud/mode events only push the state fields they actually affect
	 *   (cloud auth, org settings, profiles, etc.) without interfering with task message streaming.
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		const state = await this.getStateToPostToWebview({ includeTaskHistory: false })
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		await this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Fetches marketplace data on demand to avoid blocking main state updates
	 */
	async fetchMarketplaceData() {
		try {
			const [marketplaceResult, marketplaceInstalledMetadata] = await Promise.all([
				this.marketplaceManager.getMarketplaceItems().catch((error) => {
					console.error("Failed to fetch marketplace items:", error)
					return { organizationMcps: [], marketplaceItems: [], errors: [error.message] }
				}),
				this.marketplaceManager.getInstallationMetadata().catch((error) => {
					console.error("Failed to fetch installation metadata:", error)
					return { project: {}, global: {} } as MarketplaceInstalledMetadata
				}),
			])

			// Send marketplace data separately
			await this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: marketplaceResult.organizationMcps || [],
				marketplaceItems: marketplaceResult.marketplaceItems || [],
				marketplaceInstalledMetadata: marketplaceInstalledMetadata || { project: {}, global: {} },
				errors: marketplaceResult.errors,
			})
		} catch (error) {
			console.error("Failed to fetch marketplace data:", error)

			// Send empty data on error to prevent UI from hanging
			await this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: [],
				marketplaceItems: [],
				marketplaceInstalledMetadata: { project: {}, global: {} },
				errors: [error instanceof Error ? error.message : String(error)],
			})

			// Show user-friendly error notification for network issues
			if (error instanceof Error && error.message.includes("timeout")) {
				vscode.window.showWarningMessage(
					"Marketplace data could not be loaded due to network restrictions. Core functionality remains available.",
				)
			}
		}
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	/**
	 * Common utility for merging command lists from global state and workspace configuration.
	 * Implements the Command Denylist feature's merging strategy with proper validation.
	 *
	 * @param configKey - VSCode workspace configuration key
	 * @param commandType - Type of commands for error logging
	 * @param globalStateCommands - Commands from global state
	 * @returns Merged and deduplicated command list
	 */
	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			// Validate and sanitize global state commands
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Get workspace configuration commands
			const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

			// Validate and sanitize workspace commands
			const validWorkspaceCommands = Array.isArray(workspaceCommands)
				? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Combine and deduplicate commands
			// Global state takes precedence over workspace configuration
			const mergedCommands = [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]

			return mergedCommands
		} catch (error) {
			console.error(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	async getStateToPostToWebview({ includeTaskHistory = true }: GetStateOptions = {}): Promise<ExtensionState> {
		// Ensure the store is initialized before reading task history
		await this.taskHistoryStore.initialized

		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			allowedReadFiles,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			allowedWriteFiles,
			alwaysAllowExecute,
			destructiveCommandGuardEnabled,
			allowedCommands,
			deniedCommands,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext,
			autoCondenseContextPercent,
			soundEnabled,
			ttsEnabled,
			ttsSpeed,
			enableCheckpoints,
			checkpointTimeout,
			soundVolume,
			writeDelayMs,
			diffFuzzyThreshold,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled,
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			terminalProfile,
			mcpEnabled,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
			mode,
			customModePrompts,
			customSupportPrompts,
			enhancementApiConfigId,
			autoApprovalEnabled,
			customModes,
			experiments,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			disabledTools,
			telemetrySetting,
			showRooIgnoredFiles,
			enableSubfolderRules,
			language,
			maxImageFileSize,
			maxTotalImageSize,
			historyPreviewCollapsed,
			reasoningBlockCollapsed,
			chatFontSize,
			enterBehavior,
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexConfig,
			codebaseIndexModels,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			lockApiConfigAcrossModes,
			autoCloseZooOpenedFiles,
			autoCloseZooOpenedFilesAfterUserEdited,
			autoCloseZooOpenedNewFiles,
		} = await this.getState({ includeTaskHistory: false })

		let cloudOrganizations: CloudOrganizationMembership[] = []

		try {
			if (!CloudService.instance.isCloudAgent) {
				const now = Date.now()

				if (
					this.cloudOrganizationsCache !== null &&
					this.cloudOrganizationsCacheTimestamp !== null &&
					now - this.cloudOrganizationsCacheTimestamp < ClineProvider.CLOUD_ORGANIZATIONS_CACHE_DURATION_MS
				) {
					cloudOrganizations = this.cloudOrganizationsCache!
				} else {
					cloudOrganizations = await CloudService.instance.getOrganizationMemberships()
					this.cloudOrganizationsCache = cloudOrganizations
					this.cloudOrganizationsCacheTimestamp = now
				}
			}
		} catch (error) {
			// Ignore this error.
		}

		const telemetryKey = process.env.POSTHOG_API_KEY
		const machineId = vscode.env.machineId
		const vscodeTelemetryEnabled = vscode.env.isTelemetryEnabled
		const mergedAllowedCommands = this.mergeAllowedCommands(allowedCommands)
		const mergedDeniedCommands = this.mergeDeniedCommands(deniedCommands)
		const cwd = this.cwd
		const currentTask = this.getCurrentTask()
		let zooCodeState: {
			zooCodeIsAuthenticated: boolean
			zooCodeUserName: string | undefined
			zooCodeUserEmail: string | undefined
			zooCodeUserImage: string | undefined
			zooCodeBaseUrl: string
			deviceName: string
		} = {
			zooCodeIsAuthenticated: false,
			zooCodeUserName: undefined,
			zooCodeUserEmail: undefined,
			zooCodeUserImage: undefined,
			zooCodeBaseUrl: "https://www.zoocode.dev",
			deviceName: os.hostname(),
		}

		try {
			const { isZooCodeAuthenticated, getCachedZooCodeUserInfo, getZooCodeBaseUrl } =
				await import("../../services/zoo-code-auth")
			const userInfo = getCachedZooCodeUserInfo()
			zooCodeState = {
				zooCodeIsAuthenticated: await isZooCodeAuthenticated(),
				zooCodeUserName: userInfo.name,
				zooCodeUserEmail: userInfo.email,
				zooCodeUserImage: userInfo.image,
				zooCodeBaseUrl: getZooCodeBaseUrl(),
				deviceName: os.hostname(),
			}
		} catch {
			// Keep the default unauthenticated state if the optional Zoo Code auth service is unavailable.
		}

		const state: ExtensionState = {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
			allowedReadFiles: allowedReadFiles ?? [],
			alwaysAllowWrite: alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
			allowedWriteFiles: allowedWriteFiles ?? [],
			alwaysAllowExecute: alwaysAllowExecute ?? false,
			destructiveCommandGuardEnabled,
			alwaysAllowMcp: alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext: autoCondenseContext ?? true,
			autoCondenseContextPercent: autoCondenseContextPercent ?? 100,
			uriScheme: vscode.env.uriScheme,
			currentTaskId: currentTask?.taskId,
			currentTaskItem: currentTask?.taskId ? this.taskHistoryStore.get(currentTask.taskId) : undefined,
			clineMessages: currentTask?.clineMessages || [],
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages,
			taskHistory: includeTaskHistory
				? this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task)
				: [],
			soundEnabled: soundEnabled ?? false,
			ttsEnabled: ttsEnabled ?? false,
			ttsSpeed: ttsSpeed ?? 1.0,
			enableCheckpoints: enableCheckpoints ?? true,
			checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			soundVolume: soundVolume ?? 0.5,
			writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			diffFuzzyThreshold: diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD,
			terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: terminalCommandDelay ?? 0,
			terminalPowershellCounter: terminalPowershellCounter ?? false,
			terminalZshClearEolMark: terminalZshClearEolMark ?? true,
			terminalZshOhMy: terminalZshOhMy ?? false,
			terminalZshP10k: terminalZshP10k ?? false,
			terminalZdotdir: terminalZdotdir ?? false,
			terminalProfile,
			mcpEnabled: mcpEnabled ?? true,
			currentApiConfigName:
				currentApiConfigName ??
				((await this.isExplicitProfileClearInForce(currentTask?.taskId)) ? undefined : "default"),
			listApiConfigMeta: listApiConfigMeta ?? [],
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: mode ?? defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			customModes,
			experiments: experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: maxWorkspaceFiles ?? 200,
			cwd,
			disabledTools,
			telemetrySetting,
			telemetryKey,
			machineId,
			vscodeTelemetryEnabled,
			showRooIgnoredFiles: showRooIgnoredFiles ?? false,
			enableSubfolderRules: enableSubfolderRules ?? false,
			language: language ?? formatLanguage(vscode.env.language),
			renderContext: this.renderContext,
			maxImageFileSize: maxImageFileSize ?? 5,
			maxTotalImageSize: maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
			chatFontSize,
			enterBehavior: enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated: cloudIsAuthenticated ?? false,
			cloudAuthSkipModel: this.context.globalState.get<boolean>("roo-auth-skip-model") ?? false,
			cloudOrganizations,
			sharingEnabled: sharingEnabled ?? false,
			publicSharingEnabled: publicSharingEnabled ?? false,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? providerIdentifiers.openai,
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider: codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			// Phase 1 cloud removal: do not let Cloud-auth MDM enforcement force login-only UI flows.
			mdmCompliant: undefined,
			profileThresholds: profileThresholds ?? {},
			cloudApiUrl: getRooCodeApiUrl(),
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: includeCurrentTime ?? true,
			includeCurrentCost: includeCurrentCost ?? true,
			maxGitStatusFiles: maxGitStatusFiles ?? 0,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			autoCloseZooOpenedFiles: autoCloseZooOpenedFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES,
			autoCloseZooOpenedFilesAfterUserEdited:
				autoCloseZooOpenedFilesAfterUserEdited ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED,
			autoCloseZooOpenedNewFiles: autoCloseZooOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			kimiCodeIsAuthenticated: await (async () => {
				try {
					const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
					return await kimiCodeOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			kimiCodeOAuthState: await (async () => {
				try {
					const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
					return kimiCodeOAuthManager.getState()
				} catch {
					return undefined
				}
			})(),
			...zooCodeState,
			platform: process.platform,
			arch: process.arch,
			debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
		}

		// A failed post-commit handoff projection leaves global state stale for
		// the committed child. While that child is current, derive its execution
		// fields from the child's authoritative task-local context so partial
		// global writes cannot misreport its mode/profile/configuration.
		const staleHandoffProjection = this.staleProviderHandoffProjection
		if (staleHandoffProjection) {
			// Supersession fence: any successful ADMITTED mode/profile mutation
			// has already cleared an outdated marker in place, so a marker still
			// present here is authoritative for this child.
			if (currentTask?.taskId === staleHandoffProjection.childTaskId) {
				state.mode = staleHandoffProjection.requestedMode
				// The explicit intent decides the published identity: `set`
				// names it, `clear` publishes the explicit absence (undefined,
				// never the "default" fallback), `preserve` leaves the global
				// identity untouched.
				if (staleHandoffProjection.profileIntent.kind === "set") {
					state.currentApiConfigName = staleHandoffProjection.profileIntent.name
				} else if (staleHandoffProjection.profileIntent.kind === "clear") {
					state.currentApiConfigName = undefined
				}
				state.apiConfiguration = structuredClone(staleHandoffProjection.apiConfiguration)
			} else {
				// The stale child is no longer current; the marker is obsolete.
				this.staleProviderHandoffProjection = undefined
			}
		}

		return state
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState({ includeTaskHistory = true }: GetStateOptions = {}): Promise<
		Omit<
			ExtensionState,
			"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		// Determine apiProvider with the same logic as before, while filtering retired providers.
		const apiProvider: ProviderName =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
				? stateValues.apiProvider
				: providerIdentifiers.anthropic

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		let organizationAllowList = ORGANIZATION_ALLOW_ALL

		try {
			organizationAllowList = await CloudService.instance.getAllowList()
		} catch (error) {
			console.error(
				`[getState] failed to get organization allow list: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudUserInfo: CloudUserInfo | null = null

		try {
			cloudUserInfo = CloudService.instance.getUserInfo()
		} catch (error) {
			console.error(
				`[getState] failed to get cloud user info: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudIsAuthenticated: boolean = false

		try {
			cloudIsAuthenticated = CloudService.instance.isAuthenticated()
		} catch (error) {
			console.error(
				`[getState] failed to get cloud authentication state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		const sharingEnabled: boolean = false

		const publicSharingEnabled: boolean = false

		let organizationSettingsVersion: number = -1

		try {
			if (CloudService.hasInstance()) {
				const settings = CloudService.instance.getOrganizationSettings()
				organizationSettingsVersion = settings?.version ?? -1
			}
		} catch (error) {
			console.error(
				`[getState] failed to get organization settings version: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		const taskSyncEnabled: boolean = false

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			allowedReadFiles: stateValues.allowedReadFiles ?? [],
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			allowedWriteFiles: stateValues.allowedWriteFiles ?? [],
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			destructiveCommandGuardEnabled:
				stateValues.destructiveCommandGuardEnabled ?? DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? 100,
			taskHistory: includeTaskHistory ? this.taskHistoryStore.getAll() : [],
			allowedCommands: stateValues.allowedCommands,
			deniedCommands: stateValues.deniedCommands,
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			diffFuzzyThreshold: stateValues.diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			terminalProfile: stateValues.terminalProfile,
			mode: stateValues.mode ?? defaultModeSlug,
			language: stateValues.language ?? formatLanguage(vscode.env.language),
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			// Preserve an explicit no-profile handoff for the current child:
			// publish the absence instead of the legacy "default" fallback.
			currentApiConfigName:
				stateValues.currentApiConfigName ??
				((await this.isExplicitProfileClearInForce(this.getCurrentTask()?.taskId)) ? undefined : "default"),
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			telemetrySetting: stateValues.telemetrySetting || "unset",
			showRooIgnoredFiles: stateValues.showRooIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			chatFontSize: stateValues.chatFontSize,
			enterBehavior: stateValues.enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? providerIdentifiers.openai,
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			taskSyncEnabled,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
			autoCloseZooOpenedFiles: stateValues.autoCloseZooOpenedFiles,
			autoCloseZooOpenedFilesAfterUserEdited: stateValues.autoCloseZooOpenedFilesAfterUserEdited,
			autoCloseZooOpenedNewFiles: stateValues.autoCloseZooOpenedNewFiles,
		}
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the updated history to the webview.
	 * Now delegates to TaskHistoryStore for per-task file persistence.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated history to the webview (default: true)
	 * @returns The updated task history array
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		const { broadcast = true } = options

		const history = await this.taskHistoryStore.upsert(item)
		this.recentTasksCache = undefined

		// Broadcast the updated history to the webview if requested.
		// Prefer per-item updates to avoid repeatedly cloning/sending the full history.
		if (broadcast && this.isViewLaunched) {
			const updatedItem = this.taskHistoryStore.get(item.id) ?? item
			await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}

		return history
	}

	/**
	 * Schedule a debounced write-through of task history to globalState.
	 * Only used for backward compatibility during the transition period.
	 * Per-task files are authoritative; globalState is the downgrade fallback.
	 */
	private scheduleGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
		}

		this.globalStateWriteThroughTimer = setTimeout(async () => {
			this.globalStateWriteThroughTimer = null
			try {
				const items = this.taskHistoryStore.getAll()
				await this.updateGlobalState("taskHistory", items)
			} catch (err) {
				this.log(
					`[scheduleGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}, ClineProvider.GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS)
	}

	/**
	 * Flush any pending debounced globalState write-through immediately.
	 */
	private flushGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
			this.globalStateWriteThroughTimer = null
		}

		const items = this.taskHistoryStore.getAll()
		this.updateGlobalState("taskHistory", items).catch((err) => {
			this.log(`[flushGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	/**
	 * Broadcasts a task history update to the webview.
	 * This sends a lightweight message with just the task history, rather than the full state.
	 * @param history The task history to broadcast (if not provided, reads from the store)
	 */
	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.isViewLaunched) {
			return
		}

		const taskHistory = history ?? this.taskHistoryStore.getAll()

		// Sort and filter the history the same way as getStateToPostToWebview
		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => b.ts - a.ts)

		await this.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof RooCodeSettings>(key: K, value: RooCodeSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof RooCodeSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: RooCodeSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		// Log out from cloud if authenticated
		if (CloudService.hasInstance()) {
			try {
				await CloudService.instance.logout()
			} catch (error) {
				this.log(
					`Failed to logout from cloud during reset: ${error instanceof Error ? error.message : String(error)}`,
				)
				// Continue with reset even if logout fails
			}
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.removeClineFromStack()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	get messages() {
		return this.getCurrentTask()?.clineMessages || []
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Check if the current state is compliant with MDM policy
	 * @returns true if compliant or no MDM policy exists, false if MDM policy exists and user is non-compliant
	 */
	public checkMdmCompliance(): boolean {
		if (!this.mdmService) {
			return true // No MDM service, allow operation
		}

		const compliance = this.mdmService.isCompliant()

		if (!compliance.compliant) {
			return false
		}

		return true
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					void this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			void this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	public getCurrentTask(): Task | undefined {
		return this.taskRegistry.current
	}

	private logWebviewHiddenDiagnostics(): void {
		const task = this.getCurrentTask()
		if (!task || task.abort || task.abandoned) {
			return
		}
		this.log(
			`[Zoo Code] Webview hidden during active task.\n` +
				`  taskId:       ${task.taskId}\n` +
				`  messageCount: ${task.clineMessages.length}\n` +
				`  stackDepth:   ${this.taskRegistry.length}\n` +
				`  timestamp:    ${new Date().toISOString()}\n` +
				`If the panel appears gray after this, share this log with support@zoocode.dev`,
		)
	}

	public getRecentTasks(): string[] {
		if (this.recentTasksCache) {
			return this.recentTasksCache
		}

		const history = this.taskHistoryStore.getAll()
		const workspaceTasks: HistoryItem[] = []

		for (const item of history) {
			if (!item.ts || !item.task || item.workspace !== this.cwd) {
				continue
			}

			workspaceTasks.push(item)
		}

		if (workspaceTasks.length === 0) {
			this.recentTasksCache = []
			return this.recentTasksCache
		}

		workspaceTasks.sort((a, b) => b.ts - a.ts)
		let recentTaskIds: string[] = []

		if (workspaceTasks.length >= 100) {
			// If we have at least 100 tasks, return tasks from the last 7 days.
			const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

			for (const item of workspaceTasks) {
				// Stop when we hit tasks older than 7 days.
				if (item.ts < sevenDaysAgo) {
					break
				}

				recentTaskIds.push(item.id)
			}
		} else {
			// Otherwise, return the most recent 100 tasks (or all if less than 100).
			recentTaskIds = workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
		}

		this.recentTasksCache = recentTaskIds
		return this.recentTasksCache
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions & { handoffExecutionContext?: TaskHandoffExecutionContext } = {},
		configuration: RooCodeSettings = {},
	): Promise<Task> {
		if (configuration) {
			await this.setValues(configuration)

			if (configuration.allowedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.deniedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .roomodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const {
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			experiments,
			organizationAllowList,
			diffFuzzyThreshold,
		} = await this.getState()

		// Single-open-task invariant: always enforce for user-initiated top-level tasks.
		if (!parentTask) {
			await this.evictCurrentTask().catch(() => {
				// Non-fatal
			})
		}

		// Handoff delegation passes an explicit, already-prepared execution
		// context; it must be validated as all-or-none and used as-is instead
		// of the global state values. Ordinary (non-handoff) initialization is
		// unchanged: apiConfiguration comes from provider state as before.
		const handoffExecutionContext = options.handoffExecutionContext
		if (handoffExecutionContext !== undefined && !isCompleteTaskHandoffExecutionContext(handoffExecutionContext)) {
			throw new Error(
				"[createTask] handoffExecutionContext must be complete: mode, apiConfiguration, and apiConfigName are required together",
			)
		}
		const resolvedApiConfiguration = handoffExecutionContext?.apiConfiguration ?? apiConfiguration

		if (!ProfileValidator.isProfileAllowed(resolvedApiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = new Task({
			provider: this,
			apiConfiguration: resolvedApiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			// One config source: every profile-derived constructor input —
			// including the mistake limit the API handler guard enforces — must
			// come from the SAME resolved configuration the child's API handler
			// is built from, not from the pre-handoff global state.
			consecutiveMistakeLimit: resolvedApiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: this.taskRegistry.getAll()[0],
			parentTask,
			taskNumber: this.taskRegistry.length + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: options.initialTodos,
			// Ensure this task is present in the registry before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			diffFuzzyThreshold,
			...options,
			rateLimitClock: this.rateLimitClock,
		})

		await this.addClineToStack(task)
		if (options.startTask !== false) {
			scheduleTask(this.taskScheduler, task, "createTask")
		}

		this.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTask(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		console.log(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)
		await this.cancelTaskInternal(task)
	}

	private async cancelTaskInternal(task: Task): Promise<void> {
		let historyItem: HistoryItem | undefined
		try {
			const history = await this.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			if (error instanceof Error && error.message === "Task not found") {
				this.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		// Preserve parent and root task information for history item.
		let rootTask = task.rootTask
		let parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		task.cancelCurrentRequest()

		// Kick off abort (sets abort flag synchronously; stream exit and final saveClineMessages
		// happen asynchronously). We capture the promise so we can await its completion below —
		// this ensures task.initialStatus ("active") cannot overwrite "interrupted" after we
		// persist it (issue #560).
		const abortPromise = task.abortTask()

		// Immediately mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		await pWaitFor(
			() =>
				this.getCurrentTask()! === undefined ||
				this.getCurrentTask()!.isStreaming === false ||
				this.getCurrentTask()!.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				this.getCurrentTask()!.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			console.error("Failed to abort task")
		})

		// Wait for abortTask to fully settle (including its final saveClineMessages write)
		// before we persist "interrupted", so our write is always the last one.
		await abortPromise.catch(() => {})

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		if (task.parentTaskId) {
			try {
				await this.runDelegationTransition(task.parentTaskId, async () => {
					const { historyItem: parentHistory } = await this.getTaskWithId(task.parentTaskId!)

					if (parentHistory?.status === "delegated" && parentHistory?.awaitingChildId === task.taskId) {
						// Mark the child interrupted and leave parent delegated with awaitingChildId
						// intact — the user can resume this child later and it will report back.
						historyItem = interruptDelegatedChild(parentHistory, historyItem!)
						await this.updateTaskHistory(historyItem)
						// Clear any stale fail-closed entry from a prior failed cancel attempt so
						// reopenParentFromDelegation is not incorrectly blocked on resume.
						this.cancelledDelegationChildIds.delete(task.taskId)
						this.log(
							`[cancelTask] Marked child ${task.taskId} interrupted; parent ${task.parentTaskId} stays delegated`,
						)
					}
				})
			} catch (error) {
				// Fail closed: if we cannot persist the interrupted status, sever the link
				// so later completions don't reopen a stale delegated parent.
				parentTask = undefined
				rootTask = undefined
				this.cancelledDelegationChildIds.add(task.taskId)
				historyItem = {
					...historyItem,
					parentTaskId: undefined,
					rootTaskId: undefined,
				}
				try {
					await this.updateTaskHistory(historyItem)
				} catch (historyError) {
					this.log(
						`[cancelTask] Failed to persist interrupted child state for ${task.taskId}: ${
							historyError instanceof Error ? historyError.message : String(historyError)
						}`,
					)
					throw historyError
				}
				this.log(
					`[cancelTask] Failed to mark child interrupted for ${task.taskId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		// Clears task again, so we need to abortTask manually above.
		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		const task = this.taskRegistry.current
		if (task) {
			console.log(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
			await this.removeClineFromStack()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				releaseChannel: Package.releaseChannel,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private getCloudProperties(): CloudAppProperties {
		let cloudIsAuthenticated: boolean | undefined

		try {
			if (CloudService.hasInstance()) {
				cloudIsAuthenticated = CloudService.instance.isAuthenticated()
			}
		} catch (error) {
			// Silently handle errors to avoid breaking telemetry collection.
			this.log(`[getTelemetryProperties] Failed to get cloud auth state: ${error}`)
		}

		return {
			cloudIsAuthenticated,
		}
	}

	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const { language = "en", mode, apiConfiguration } = await this.getState()

		const task = this.getCurrentTask()
		const todoList = task?.todoList
		let todos: { total: number; completed: number; inProgress: number; pending: number } | undefined

		if (todoList && todoList.length > 0) {
			todos = {
				total: todoList.length,
				completed: todoList.filter((todo) => todo.status === "completed").length,
				inProgress: todoList.filter((todo) => todo.status === "in_progress").length,
				pending: todoList.filter((todo) => todo.status === "pending").length,
			}
		}

		const apiProvider = apiConfiguration?.apiProvider

		return {
			language,
			mode,
			taskId: task?.taskId,
			parentTaskId: task?.parentTaskId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: task?.api?.getModel().id,
			diffStrategy: task?.diffStrategy?.getName(),
			isSubtask: task ? !!task.parentTaskId : undefined,
			...(todos && { todos }),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...this.getCloudProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	/**
	 * Read-only provider handoff preparation.
	 *
	 * Captures everything the child will execute with — requested mode, profile
	 * decision (source/name/stable id), and a deep-cloned full API
	 * configuration including provider secret fields — while the delegating
	 * parent is still the current task. Read-only and deliberately off the
	 * provider profile mutation queue; performs zero writes to global state,
	 * the profile store, or any task. If this rejects, the caller aborts
	 * delegation before the parent is removed, leaving the parent current and
	 * every store unchanged.
	 */
	private async prepareProviderHandoffContext(requestedMode: Mode): Promise<PreparedProviderHandoffContext> {
		// Read-only preparation deliberately does NOT run on the provider
		// profile mutation queue: a hung or timed-out underlying mutation must
		// never block delegation preparation (queue liveness). Every read here
		// is either a single-lock durable snapshot (ProviderSettingsManager
		// locks its own store) or a synchronous ContextProxy read, and no write
		// happens, so ordering against queued mutations is not required for
		// safety: the prepared context is a point-in-time snapshot and later
		// successful mutations supersede it through the generation fence.
		const locked = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		const snapshot = await this.providerSettingsManager.snapshotForHandoff(requestedMode)

		const currentEntry = snapshot.currentApiConfigName
			? snapshot.entries.find((entry) => entry.name === snapshot.currentApiConfigName)
			: undefined
		const currentProfileRef =
			snapshot.currentApiConfigName !== undefined
				? { name: snapshot.currentApiConfigName, id: currentEntry?.id }
				: undefined

		// A saved mapping whose profile has no real provider settings is
		// treated as unsaved: the child continues with the current
		// configuration instead of activating an unconfigured profile.
		const savedProfile = snapshot.savedProfile?.apiProvider ? snapshot.savedProfile : undefined
		const hadSavedMapping = snapshot.modeApiConfigId !== undefined

		const decision = decideProviderHandoffProfile({
			locked,
			currentProfile: currentProfileRef,
			savedProfile: savedProfile ? { name: savedProfile.name, id: savedProfile.id } : undefined,
		})

		let apiConfiguration: ProviderSettings
		if (savedProfile) {
			const { name: _savedProfileName, id: _savedProfileId, ...profileSettings } = savedProfile
			apiConfiguration = structuredClone(profileSettings)
		} else {
			apiConfiguration = structuredClone(this.contextProxy.getProviderSettings())
		}

		return createPreparedProviderHandoffContext({
			requestedMode,
			profile: { source: decision.source, name: decision.profile?.name, id: decision.profile?.id },
			apiConfiguration,
			// Persist the mode mapping post-commit for the saved profile
			// (parity with the previous activation flow) and for a genuinely
			// unsaved mode. A saved-but-unusable mapping is left untouched.
			persistModeProfileId:
				savedProfile?.id ??
				(hadSavedMapping
					? undefined
					: decision.source === "unsaved-current"
						? decision.persistModeProfileId
						: undefined),
		})
	}

	/**
	 * Best-effort restoration of the parent when child creation fails after the
	 * parent was removed from the stack. Never masks the original error.
	 */
	private async restoreParentAfterFailedChildCreation(
		parentTaskId: string,
		transitionOwner?: symbol,
	): Promise<boolean> {
		try {
			const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)
			await this.createTaskWithHistoryItem(parentHistory, { transitionOwner })
			return true
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Failed to restore parent ${parentTaskId} after child creation failure: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return false
		}
	}

	/**
	 * Authoritative reconciliation after a rejected delegation commit.
	 *
	 * At the atomic write boundary only parent history is guaranteed durable;
	 * the child's history record may legitimately be absent. The parent record
	 * is therefore re-read strictly from disk with {@link TaskHistoryStore.readFresh},
	 * which — unlike the `invalidate`/`get` path — distinguishes a definitively
	 * missing record from one that exists but cannot be read or parsed.
	 * Callers run this while still holding the per-parent delegation transition
	 * lock and pass the commit-owned parent fields captured before the update
	 * attempt (the preimage).
	 *
	 * - `committed` (observation `exact`): the parent record is durably
	 *   delegated to this attempted child. The child record is optional: a
	 *   missing child history is expected; only a present record that
	 *   contradicts the lineage degrades the observation. Nothing may be
	 *   rolled back.
	 * - `incoherent` (observations `other-child` / `missing` / `unreadable`):
	 *   the parent shows a delegation to a different child, is absent, or is
	 *   unreadable — durability is unknowable, so no destructive rollback may
	 *   run.
	 * - `uncommitted` (observation `unchanged`): the parent record exactly
	 *   matches the safe nondelegated preimage on status, awaitingChildId,
	 *   childIds, and pendingAction ownership — nothing persisted, so the
	 *   rollback is safe. Any preimage mismatch degrades instead.
	 */
	private async reconcileDelegationCommitFailure(
		parentTaskId: string,
		childTaskId: string,
		preimage: {
			status: HistoryItem["status"]
			awaitingChildId: HistoryItem["awaitingChildId"]
			childIds: HistoryItem["childIds"]
			pendingAction: HistoryItem["pendingAction"]
		},
	): Promise<{
		durability: "committed" | "uncommitted" | "incoherent"
		observation: ProviderHandoffCommitObservation
		errors: unknown[]
	}> {
		let parentRead: StrictTaskReadResult
		try {
			parentRead = await this.taskHistoryStore.readFresh(parentTaskId)
		} catch (error) {
			// A re-read failure must never trigger a destructive rollback.
			return { durability: "incoherent", observation: "unreadable", errors: [error] }
		}

		if (parentRead.kind === "error") {
			return { durability: "incoherent", observation: "unreadable", errors: [parentRead.error] }
		}

		if (parentRead.kind === "missing") {
			return { durability: "incoherent", observation: "missing", errors: [] }
		}

		const parent = parentRead.item

		// Exact delegated-to-attempted-child: committed regardless of whether
		// the child's own history exists yet.
		if (parent.status === "delegated" && parent.awaitingChildId === childTaskId) {
			try {
				const childRead = await this.taskHistoryStore.readFresh(childTaskId)
				// Only a present child record that contradicts the lineage
				// makes the observation incoherent; a missing or unreadable
				// child history cannot contradict the authoritative parent.
				if (childRead.kind === "found" && childRead.item.parentTaskId !== parentTaskId) {
					return { durability: "incoherent", observation: "contradictory-child", errors: [] }
				}
			} catch (error) {
				// A contradicting child record cannot be established from a
				// failed read; the parent record alone stays authoritative.
				void error
			}
			return { durability: "committed", observation: "exact", errors: [] }
		}

		// Compare the commit-owned fields against the preimage captured before
		// the update attempt. An exact match — nondelegated or still showing
		// the pre-attempt delegation a re-delegation severed — proves this
		// attempt persisted nothing, so the rollback is safe.
		const unchanged =
			parent.status === preimage.status &&
			parent.awaitingChildId === preimage.awaitingChildId &&
			JSON.stringify(parent.childIds ?? []) === JSON.stringify(preimage.childIds ?? []) &&
			parent.pendingAction?.actionId === preimage.pendingAction?.actionId
		if (unchanged) {
			return { durability: "uncommitted", observation: "unchanged", errors: [] }
		}

		// A delegation to a different child that the preimage did not show must
		// never be rolled back over.
		if (parent.status === "delegated") {
			return { durability: "incoherent", observation: "other-child", errors: [] }
		}

		// The record drifted from the preimage in any other way: another writer
		// moved it and durability is unknowable.
		return { durability: "incoherent", observation: "drifted", errors: [] }
	}

	/**
	 * Roll back a failed delegation after the parent was removed: close the
	 * paused child if it is still on top of the stack, delete the child, and
	 * restore the parent. Returns the errors of failed rollback steps so the
	 * caller can preserve the original failure while surfacing incomplete
	 * cleanup.
	 */
	private async rollbackFailedDelegation(
		parentTaskId: string,
		childTaskId: string,
		transitionOwner?: symbol,
	): Promise<{ cleanupErrors: unknown[]; restorationErrors: unknown[] }> {
		const cleanupErrors: unknown[] = []
		const restorationErrors: unknown[] = []

		try {
			// Only pop the stack if the child we just created is still on top.
			// A concurrent delegation could have pushed another child since we created ours.
			if (this.getCurrentTask()?.taskId === childTaskId) {
				await this.removeClineFromStack()
			}
		} catch (error) {
			cleanupErrors.push(error)
			this.log(
				`[delegateParentAndOpenChild] Failed to close paused child ${childTaskId} during rollback: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		try {
			await this.deleteTaskWithId(childTaskId, false)
		} catch (error) {
			cleanupErrors.push(error)
			this.log(
				`[delegateParentAndOpenChild] Failed to delete paused child ${childTaskId} during rollback: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		try {
			const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)
			await this.createTaskWithHistoryItem(parentHistory, { transitionOwner })
		} catch (error) {
			restorationErrors.push(error)
			this.log(
				`[delegateParentAndOpenChild] Failed to restore parent ${parentTaskId} during rollback: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		return { cleanupErrors, restorationErrors }
	}

	/**
	 * Named post-commit projection writes. Each operation reports its own
	 * outcome so boundary classification never depends on result ordering.
	 * Every write checks the abort fence before starting: after the bounded
	 * queue timeout no further write begins, so an abandoned operation cannot
	 * interleave writes with a later generation.
	 */
	private async runProviderHandoffProjectionWrites(
		prepared: Readonly<PreparedProviderHandoffContext>,
		signal: AbortSignal,
	): Promise<NamedProviderHandoffProjectionResult[]> {
		const namedStep = async <T>(
			operation: ProviderHandoffProjectionOperation,
			write: () => Promise<T>,
		): Promise<{ result: NamedProviderHandoffProjectionResult; value?: T }> => {
			if (signal.aborted) {
				return { result: { operation, ok: false, error: new Error(`aborted before ${operation}`) } }
			}
			try {
				return { result: { operation, ok: true }, value: await write() }
			} catch (error) {
				return { result: { operation, ok: false, error } }
			}
		}

		const intent = prepared.profile.intent

		// `preserve` performs no profile-identity write at all: the durable
		// profile store and the legacy global identity are left untouched.
		// `set` writes the prepared identity; `clear` writes the absence —
		// undefined, never a skipped write.
		const [mode, meta, providerSettings, profileStore] = await Promise.all([
			namedStep("global-mode", () => this.updateGlobalState("mode", prepared.requestedMode)),
			namedStep("profile-meta-read", () => this.providerSettingsManager.listConfig()),
			namedStep("provider-settings", () =>
				this.contextProxy.setProviderSettings(structuredClone(prepared.apiConfiguration)),
			),
			intent.kind === "preserve"
				? Promise.resolve({ result: { operation: "profile-store" as const, ok: true } })
				: namedStep("profile-store", () =>
						this.providerSettingsManager.projectHandoffState({
							intent,
							mode: prepared.requestedMode,
							modeConfigId: prepared.persistModeProfileId,
						}),
					),
		])

		const results: NamedProviderHandoffProjectionResult[] = [
			mode.result,
			meta.result,
			providerSettings.result,
			profileStore.result,
		]

		// Dependent writes run only when the read that feeds them succeeded.
		const listConfig = meta.result.ok ? meta.value : undefined
		if (listConfig !== undefined) {
			results.push(
				(await namedStep("global-config-meta", () => this.updateGlobalState("listApiConfigMeta", listConfig)))
					.result,
			)
		}
		if (intent.kind === "set") {
			results.push(
				(
					await namedStep("global-profile-name", () =>
						this.updateGlobalState("currentApiConfigName", intent.name),
					)
				).result,
			)
		} else if (intent.kind === "clear") {
			// Explicit clear: write undefined so legacy global state stops
			// claiming a profile identity the child does not have.
			results.push(
				(
					await namedStep("global-profile-name", () =>
						this.updateGlobalState("currentApiConfigName", undefined),
					)
				).result,
			)
		}

		return results
	}

	/**
	 * Best-effort post-commit projection of the prepared handoff context onto
	 * legacy global state and the durable profile store. Runs strictly AFTER
	 * the durable delegation commit, as fire-and-forget background work: it can
	 * never undo the commit, never blocks the per-parent delegation lock, and
	 * never delays the child start. The queue batch is bounded for the caller —
	 * an admission timeout abandons it before any write; once a write has
	 * started the queue stays owned until the non-cancellable storage write
	 * settles. A failed/abandoned projection stamps the generation-fenced stale
	 * marker, superseded by any later successful ADMITTED mode/profile mutation.
	 * Every settlement is additionally gated by
	 * {@link isProviderHandoffProjectionStillRelevant} on the projection's
	 * immutable token identity: once the prepared child leaves the provider
	 * (removed, completed, abandoned, or deleted) — or its task ID is reused by
	 * a newer projection — or the provider disposes, completion is inert and
	 * never recreates stale or explicit-clear state.
	 */
	private async projectPreparedProviderHandoffState(
		prepared: Readonly<PreparedProviderHandoffContext>,
		childTaskId: string,
	): Promise<ProviderHandoffProjectionOutcome> {
		// Allocate the immutable projection identity and register the target
		// synchronously, before the bounded queue can admit or abandon the
		// operation: a child that leaves the provider drops this registration
		// (via invalidateProviderHandoffProjectionState), and a newer
		// registration for a reused task ID replaces this token, so a deferred
		// settlement can never resurrect stale/clear state for it.
		const projectionToken = this.registerProviderHandoffProjectionTarget(childTaskId)
		// Bound at admission; stays undefined when the bounded queue abandons
		// the operation before it runs (zero writes — the marker it stamps, if
		// any, carries no admitted generation and is superseded by any later
		// successful admitted mutation).
		let admittedGeneration: number | undefined
		try {
			return await this.enqueueProviderProfileMutation(async (signal, generation) => {
				admittedGeneration = generation
				// Bind the admitted generation to this projection's exact token
				// for the relevance fence below. A no-op if the registration was
				// already replaced or removed.
				this.admitProviderHandoffProjectionTarget(childTaskId, projectionToken, generation)
				// Cancel-before-start: the queue admitted the operation after
				// its own timeout fired. Perform zero writes.
				if (signal.aborted) {
					return { ok: false, boundary: "queue" }
				}
				const results = await this.runProviderHandoffProjectionWrites(prepared, signal)
				// The bounded queue may already have abandoned this operation; a
				// late completion stays inert (its outcome is discarded by the
				// caller and must not clear the marker or emit events).
				if (signal.aborted) {
					return { ok: false, boundary: "queue" }
				}
				const outcome = classifyProviderHandoffProjectionResults(results)
				// Central relevance fence: marker updates, explicit-clear state,
				// and events apply only while the provider is live, the prepared
				// child is still the registered target for this exact token, and
				// — after admission — the registration still carries exactly this
				// admitted generation with no newer mutation admitted. A
				// superseded or orphaned settlement is inert.
				if (!this.isProviderHandoffProjectionStillRelevant(childTaskId, projectionToken, generation)) {
					return outcome.ok ? { ok: true } : outcome
				}
				if (!outcome.ok) {
					this.markStaleProviderHandoffProjection(childTaskId, prepared, generation)
					// Log a stable boundary/category only: provider-originated
					// error text is never interpolated (even redacted), so
					// arbitrary remote strings cannot reach the log. The raw
					// error stays on the named result for in-memory callers and
					// is never persisted or logged here.
					const failure = results.find((result) => !result.ok)
					const failureCategory = failure?.error instanceof Error ? failure.error.name : typeof failure?.error
					this.log(
						`[delegateParentAndOpenChild] Post-commit handoff projection failed for child ${childTaskId} ` +
							`at ${outcome.failedOperation} (${failureCategory}); continuing with child-local values`,
					)
					return outcome
				}
				this.clearStaleProviderHandoffProjection(generation)
				// Preserve the external mode-change signal the previous
				// pre-removal switch emitted, now strictly after the durable
				// commit. Never emitted by an operation the queue abandoned,
				// whose generation was already superseded, that completed after
				// the provider began disposing, or whose child already left.
				try {
					this.emit(RooCodeEventName.ModeChanged, prepared.requestedMode)
				} catch {
					// non-fatal
				}
				return { ok: true }
			})
		} catch {
			// The queued projection was abandoned (bounded timeout or provider
			// disposal) before its writes completed. The durable delegation and
			// the child's authoritative task-local context are unaffected; the
			// stale marker makes publication derive child values until a later
			// successful admitted mutation supersedes it. The abandonment is
			// logged as a stable boundary only, without error detail.
			// Bookkeeping stays behind the exact-token relevance fence: a child
			// that already left the provider, a task ID reused by a newer
			// projection, or a disposed provider is never re-marked.
			if (!this.isProviderHandoffProjectionStillRelevant(childTaskId, projectionToken, admittedGeneration)) {
				return { ok: false, boundary: "queue" }
			}
			this.markStaleProviderHandoffProjection(childTaskId, prepared, admittedGeneration)
			this.log(
				`[delegateParentAndOpenChild] Post-commit handoff projection abandoned for child ${childTaskId}; ` +
					`continuing with child-local values`,
			)
			return { ok: false, boundary: "queue" }
		}
	}

	/**
	 * Delegate parent task and open child task.
	 *
	 * - Enforce single-open invariant
	 * - Read-only prepare the child's execution context while the parent is
	 *   still current (no global/profile/event/publication writes)
	 * - Persist parent delegation metadata atomically
	 * - Emit TaskDelegated (task-level; API forwards to provider/bridge)
	 * - Create the paused child from the explicit prepared context, make that
	 *   context authoritative on the child, then project legacy global state
	 * - Fail closed if preparation rejects: the parent is never removed from
	 *   the stack, so it stays the current, active task and no child is
	 *   created or scheduled. If child creation or the atomic commit fails,
	 *   the child is cleaned up and the parent is restored.
	 * - Advance the shared provider-handoff protocol at each semantic
	 *   landmark. The reducer is observational bookkeeping only: it never
	 *   persists, never throws into this flow, and never drives rollback.
	 */
	public async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
		pendingActionId?: string
	}): Promise<Task> {
		const { parentTaskId } = params
		// Full per-parent transition serialization: validation, read-only
		// preparation, parent removal, child creation, commit, reconciliation,
		// rollback, activation, projection, and child start all run inside the
		// same runDelegationTransition lock used by completion and abandonment.
		// Two same-parent delegations (or a completion/abandonment racing a
		// delegation) can therefore never interleave; later callers observe the
		// committed/delegated state when the lock releases. The wrapper delegates
		// to the unlocked implementation to avoid recursive lock acquisition.
		return this.runDelegationTransition(parentTaskId, (owner) =>
			this.delegateParentAndOpenChildUnlocked(params, owner),
		)
	}

	private async delegateParentAndOpenChildUnlocked(
		params: {
			parentTaskId: string
			message: string
			initialTodos: TodoItem[]
			mode: string
			pendingActionId?: string
		},
		transitionOwner: symbol,
	): Promise<Task> {
		const { parentTaskId, message, initialTodos, mode, pendingActionId } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent (must be current task)
		const parent = this.getCurrentTask()
		if (!parent) {
			throw new Error("[delegateParentAndOpenChild] No current task")
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, current ${parent.taskId}`,
			)
		}
		if (pendingActionId) {
			const parentHistory = this.taskHistoryStore.get(parentTaskId)
			if (parentHistory?.pendingAction?.actionId !== pendingActionId) {
				throw new Error(
					`[delegateParentAndOpenChild] Pending action mismatch for parent ${parentTaskId}: expected ${pendingActionId}, found ${parentHistory?.pendingAction?.actionId}`,
				)
			}
		}
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				console.warn(`[delegateParentAndOpenChild] Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					console.error(
						`[delegateParentAndOpenChild] CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// 3) Read-only handoff preparation while the parent is still the current
		//    task. This replaces the old mutating pre-removal mode switch: no
		//    global/profile/event/publication write happens before the durable
		//    delegation commit. If preparation rejects, delegation aborts with the
		//    parent still current and every store untouched (fail closed). The
		//    explicit prepared context also removes the ordering dependency on
		//    createTask(): the child no longer infers its mode from
		//    provider.getState() during initializeTaskMode().
		const handoff = createProviderHandoffPlan(mode)
		// Protocol bookkeeping only: the shared reducer records semantic
		// landmarks, rejects none of the steps below in a correct run, and can
		// neither persist anything nor alter rollback behavior.
		const handoffProtocol = createProviderHandoffTransaction()
		this.providerHandoffProtocol = handoffProtocol
		let prepared: PreparedProviderHandoffContext
		try {
			prepared = await this.prepareProviderHandoffContext(handoff.requestedMode)
		} catch (error) {
			// Fail-closed abort landmark: the parent was never removed and no
			// store was touched, so the protocol terminal is a clean abort.
			handoffProtocol.advance({ type: "prepare-failed" })
			throw error
		}
		handoffProtocol.advance({ type: "prepare" })

		// 4) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await this.removeClineFromStack()
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}
		handoffProtocol.advance({ type: "remove-parent" })

		// 5) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and writing to globalState via saveClineMessages → updateTaskHistory)
		// before we persist the parent's delegation metadata in step 5.
		// Without this, the child's fire-and-forget startTask() races with step 5,
		// and the last writer to globalState overwrites the other's changes—
		// causing the parent's delegation fields to be lost.
		let child: Task
		try {
			child = await this.createTask(message, undefined, parent, {
				initialTodos,
				initialStatus: "active",
				startTask: false,
				// All-or-none explicit handoff-only execution context: the child
				// must not asynchronously infer its mode/profile from mutable
				// global state. Completeness is runtime-validated by createTask
				// and the Task constructor.
				handoffExecutionContext: {
					mode: prepared.requestedMode,
					apiConfigName: prepared.profile.name,
					apiConfiguration: structuredClone(prepared.apiConfiguration),
				},
			})
		} catch (error) {
			// Child creation failed after the parent was removed: restore the
			// parent, leave the child absent, and rethrow the original error.
			const restored = await this.restoreParentAfterFailedChildCreation(parentTaskId, transitionOwner)
			handoffProtocol.advance({ type: "create-child-failed" })
			handoffProtocol.advance({ type: "rollback-restore", ok: restored })
			throw error
		}
		handoffProtocol.advance({ type: "create-child" })

		// 6) Persist parent delegation metadata BEFORE the child starts writing.
		//    atomicReadAndUpdate reads from the in-memory cache and writes back within a
		//    single lock acquisition — no concurrent writer can slip between the read and
		//    write, and the pure updater cannot re-enter the lock (no deadlock).
		//    Broadcast and cache invalidation happen outside the lock after it releases.
		//
		//    If the parent is already "delegated" to a previous interrupted child (the user
		//    navigated back to the parent and continued working), we implicitly sever the old
		//    link here (delegated → active → delegated) so no explicit Abandon step is needed.
		//    The old awaited child's status is re-read INSIDE the updater (which runs
		//    synchronously under the store lock) so a concurrent abandon or completion cannot
		//    slip between the status snapshot and the write. An active child must never be
		//    silently detached.
		// Commit-owned parent fields captured before the update attempt. After
		// a rejected commit, the strict fresh re-read compares against this
		// preimage: an exact match proves the write never persisted; any
		// mismatch means another writer moved the record.
		const preCommitParent = this.taskHistoryStore.get(parentTaskId)
		const commitPreimage = {
			status: preCommitParent?.status,
			awaitingChildId: preCommitParent?.awaitingChildId,
			childIds: preCommitParent?.childIds,
			pendingAction: preCommitParent?.pendingAction,
		}
		try {
			await this.taskHistoryStore.atomicReadAndUpdate(parentTaskId, (historyItem) => {
				if (pendingActionId && historyItem.pendingAction?.actionId !== pendingActionId) {
					throw new Error(
						`[delegateParentAndOpenChild] Pending action mismatch for parent ${parentTaskId}: expected ${pendingActionId}, found ${historyItem.pendingAction?.actionId}`,
					)
				}
				const awaitedChildStatus = historyItem.awaitingChildId
					? this.taskHistoryStore.get(historyItem.awaitingChildId)?.status
					: undefined
				const delegated = delegateTaskToChild(historyItem, child.taskId, awaitedChildStatus)
				return {
					...delegated,
					pendingAction:
						delegated.pendingAction?.actionId === pendingActionId ? undefined : delegated.pendingAction,
				}
			})
			handoffProtocol.advance({ type: "commit-delegation" })
		} catch (err) {
			handoffProtocol.advance({ type: "commit-failed" })
			this.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
			// Authoritative reconciliation while still under the per-parent
			// transition serialization: strictly re-read the parent record from
			// disk (child history is optional at this boundary) and resolve the
			// commit's ambiguous durability before any destructive action.
			const reconciliation = await this.reconcileDelegationCommitFailure(
				parentTaskId,
				child.taskId,
				commitPreimage,
			)
			if (reconciliation.durability === "committed") {
				// The rejected write actually persisted. The delegation is
				// durable: do NOT delete the child or restore the parent over
				// committed lineage — treat the handoff as committed and
				// continue with context activation below.
				handoffProtocol.advance({
					type: "observe-commit-durability",
					durability: "committed",
					observation: reconciliation.observation,
				})
				this.log(
					`[delegateParentAndOpenChild] Commit for ${parentTaskId} -> ${child.taskId} rejected after persisting; ` +
						`keeping the durable delegation and continuing`,
				)
			} else if (reconciliation.durability === "uncommitted") {
				handoffProtocol.advance({
					type: "observe-commit-durability",
					durability: "uncommitted",
					observation: reconciliation.observation,
				})
				const rollback = await this.rollbackFailedDelegation(parentTaskId, child.taskId, transitionOwner)
				handoffProtocol.advance({ type: "rollback-cleanup", ok: rollback.cleanupErrors.length === 0 })
				handoffProtocol.advance({ type: "rollback-restore", ok: rollback.restorationErrors.length === 0 })
				if (rollback.cleanupErrors.length + rollback.restorationErrors.length > 0) {
					// Preserve the original failure while surfacing incomplete
					// cleanup; the original error is first in the aggregate.
					throw new AggregateError(
						[err, ...rollback.cleanupErrors, ...rollback.restorationErrors],
						`[delegateParentAndOpenChild] Delegation rollback incomplete for parent ${parentTaskId}; original error: ${
							(err as Error)?.message ?? String(err)
						}`,
					)
				}
				throw err
			} else {
				// Incoherent records or failed re-read: never roll back
				// destructively over potentially committed lineage. Keep the
				// child paused, keep the parent record untouched, and surface
				// the ambiguity with the original error retained.
				handoffProtocol.advance({
					type: "observe-commit-durability",
					durability: "incoherent",
					observation: reconciliation.observation,
				})
				throw new AggregateError(
					[err, ...reconciliation.errors],
					`[delegateParentAndOpenChild] Delegation commit durability could not be determined for parent ${parentTaskId} -> child ${child.taskId}; ` +
						`the child is left paused and the parent record untouched`,
				)
			}
		}

		//    Post-commit webview publication is best-effort: a publication error
		//    must never roll back the durable delegation or prevent the child
		//    from starting.
		this.recentTasksCache = undefined
		if (this.isViewLaunched) {
			try {
				const updatedItem = this.taskHistoryStore.get(parentTaskId)
				if (updatedItem) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
				}
			} catch (error) {
				this.log(
					`[delegateParentAndOpenChild] Failed to publish delegation update for ${parentTaskId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		// 7) Synchronously make the prepared context authoritative on the child.
		//    The child is still paused; from here on its task-local mode, sticky
		//    profile, and apiConfiguration are authoritative no matter what the
		//    legacy global projection does.
		child.adoptHandoffExecutionContext({
			mode: prepared.requestedMode,
			apiConfigName: prepared.profile.name,
			apiConfiguration: structuredClone(prepared.apiConfiguration),
		})
		handoffProtocol.advance({ type: "activate-context" })

		// An explicit no-profile handoff keeps its explicit-clear publication
		// state for this child regardless of how the background projection ends.
		if (prepared.profile.intent.kind === "clear") {
			this.explicitProfileClearChildIds.add(child.taskId)
		}

		// 8) Start the child task immediately: the durable delegation is
		//    committed and the child's execution context is authoritative, so
		//    the child must never await the legacy projection.
		scheduleTask(this.taskScheduler, child, "delegateParentAndOpenChild")
		handoffProtocol.advance({ type: "start-child" })

		// 9) Best-effort legacy projection of the prepared context onto global
		//    state and the durable profile store — fire-and-forget background
		//    work OUTSIDE the per-parent delegation lock and OUTSIDE the
		//    child-start critical path. The promise is handled (never a floating
		//    rejection): it logs, updates generation-fenced bookkeeping, and
		//    records the protocol landmark when still relevant. Tests await the
		//    exposed completion hook deterministically instead of sleeping.
		const projectionCompletion = this.projectPreparedProviderHandoffState(prepared, child.taskId)
			.then((outcome) => {
				handoffProtocol.advance({
					type: "project-legacy",
					boundary: outcome.boundary ?? "context-proxy",
					ok: outcome.ok,
				})
				return outcome
			})
			.catch(() => {
				// Stable boundary only: provider-originated error text is never
				// interpolated into the log.
				this.log(
					`[delegateParentAndOpenChild] Background handoff projection rejected for child ${child.taskId}; ` +
						`continuing with child-local values`,
				)
				return { ok: false, boundary: "queue" as const }
			})
		this.providerHandoffProjectionCompletion = projectionCompletion
		void projectionCompletion

		// 10) Emit TaskDelegated (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch {
			// non-fatal
		}

		return child
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
		pendingActionId?: string
	}): Promise<boolean> {
		const { parentTaskId, childTaskId, completionResultSummary, pendingActionId } = params
		return this.runDelegationTransition(parentTaskId, async (transitionOwner) => {
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			// 1) Load parent from history and current persisted messages
			const { historyItem } = await this.getTaskWithId(parentTaskId)
			const childHistory = this.taskHistoryStore.get(childTaskId)
			if (pendingActionId && childHistory?.pendingAction?.actionId !== pendingActionId) {
				this.log(
					`[reopenParentFromDelegation] Aborting: child ${childTaskId} pending action does not match ${pendingActionId}`,
				)
				return false
			}

			// Guard: re-validate delegation state after the async approval gap.
			// cancelTask() or removeClineFromStack() may have already detached the parent
			// (setting status → "active", awaitingChildId → undefined) while the user was
			// approving the subtask finish.  If the parent no longer awaits this child,
			// routing output back would corrupt an unrelated task.
			if (
				this.cancelledDelegationChildIds.has(childTaskId) ||
				(historyItem.status !== "delegated" && historyItem.status !== "active") ||
				historyItem.awaitingChildId !== childTaskId
			) {
				this.log(
					`[reopenParentFromDelegation] Aborting: parent ${parentTaskId} is no longer delegated to child ${childTaskId} ` +
						`(status=${historyItem.status}, awaitingChildId=${historyItem.awaitingChildId})`,
				)
				return false
			}

			let parentClineMessages: ClineMessage[] = []
			try {
				parentClineMessages = await readTaskMessages({
					taskId: parentTaskId,
					globalStoragePath,
				})
			} catch (error) {
				this.log(
					`[reopenParentFromDelegation] Failed to read messages for parent ${parentTaskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
				return false
			}

			let parentApiMessages: ApiMessage[] = []
			try {
				parentApiMessages = await readApiMessages({
					taskId: parentTaskId,
					globalStoragePath,
				})
			} catch (error) {
				this.log(
					`[reopenParentFromDelegation] Failed to read API messages for parent ${parentTaskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
				return false
			}

			// 2) Inject synthetic records: UI subtask_result and update API tool_result
			const ts = Date.now()

			// Defensive: ensure arrays
			if (!Array.isArray(parentClineMessages)) parentClineMessages = []
			if (!Array.isArray(parentApiMessages)) parentApiMessages = []

			const subtaskUiMessage: ClineMessage = {
				messageId: crypto.randomUUID(),
				type: "say",
				say: "subtask_result",
				text: completionResultSummary,
				ts,
			}
			const lastParentClineMessage = parentClineMessages.at(-1)
			if (
				lastParentClineMessage?.type !== "say" ||
				lastParentClineMessage.say !== "subtask_result" ||
				lastParentClineMessage.text !== completionResultSummary
			) {
				parentClineMessages.push(subtaskUiMessage)
			}
			parentClineMessages = await saveTaskMessages({
				messages: parentClineMessages,
				taskId: parentTaskId,
				globalStoragePath,
				merge: true,
			})

			// Find the tool_use_id from the last assistant message's new_task tool_use
			let toolUseId: string | undefined
			for (let i = parentApiMessages.length - 1; i >= 0; i--) {
				const msg = parentApiMessages[i]
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "tool_use" && block.name === "new_task") {
							toolUseId = block.id
							break
						}
					}
					if (toolUseId) break
				}
			}

			// Preferred: if the parent history contains the native tool_use for new_task,
			// inject a matching tool_result for the Anthropic message contract:
			// user → assistant (tool_use) → user (tool_result)
			if (toolUseId) {
				// Check if the last message is already a user message with a tool_result for this tool_use_id
				// (in case this is a retry or the history was already updated)
				const lastMsg = parentApiMessages[parentApiMessages.length - 1]
				let alreadyHasToolResult = false
				if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
					for (const block of lastMsg.content) {
						if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
							// Update the existing tool_result content
							block.content = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
							alreadyHasToolResult = true
							break
						}
					}
				}

				// If no existing tool_result found, create a NEW user message with the tool_result
				if (!alreadyHasToolResult) {
					parentApiMessages.push({
						messageId: crypto.randomUUID(),
						role: "user",
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: toolUseId,
								content: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
							},
						],
						ts,
					})
				}

				// Validate the newly injected tool_result against the preceding assistant message.
				// This ensures the tool_result's tool_use_id matches a tool_use in the immediately
				// preceding assistant message (Anthropic API requirement).
				const lastMessage = parentApiMessages[parentApiMessages.length - 1]
				if (lastMessage?.role === "user") {
					const validatedMessage = validateAndFixToolResultIds(lastMessage, parentApiMessages.slice(0, -1))
					parentApiMessages[parentApiMessages.length - 1] = validatedMessage
				}
			} else {
				// If there is no corresponding tool_use in the parent API history, we cannot emit a
				// tool_result. Fall back to a plain user text note so the parent can still resume.
				const fallbackText = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
				const lastParentApiMessage = parentApiMessages.at(-1)
				const alreadyHasFallback =
					lastParentApiMessage?.role === "user" &&
					Array.isArray(lastParentApiMessage.content) &&
					lastParentApiMessage.content.some(
						(block: { type?: string; text?: string }) =>
							block.type === "text" && block.text === fallbackText,
					)
				if (!alreadyHasFallback) {
					parentApiMessages.push({
						messageId: crypto.randomUUID(),
						role: "user",
						content: [
							{
								type: "text" as const,
								text: fallbackText,
							},
						],
						ts,
					})
				}
			}

			parentApiMessages = await saveApiMessages({
				messages: parentApiMessages,
				taskId: parentTaskId,
				globalStoragePath,
				merge: true,
			})

			// 4) Close child instance if still open (single-open-task invariant).
			//    This MUST happen BEFORE marking the child "completed" because
			//    removeClineFromStack() → abortTask(true) → saveClineMessages() writes
			//    the historyItem with initialStatus (typically "active"), which would
			//    overwrite a "completed" status set later.
			const current = this.getCurrentTask()
			if (current?.taskId === childTaskId) {
				await this.removeClineFromStack()
			}

			// 3+5) Atomically mark child completed and parent active in one lock acquisition.
			//      No intermediate state is ever persisted — no sentinel needed.
			//      Build the parent update inside the updater from the locked snapshot so
			//      any concurrent write that landed between step 1 and the lock acquisition
			//      is preserved rather than silently overwritten.
			let updatedHistory!: typeof historyItem
			let completingChild!: HistoryItem
			await this.taskHistoryStore.atomicUpdatePair(
				childTaskId,
				parentTaskId,
				(child) => {
					if (pendingActionId && child.pendingAction?.actionId !== pendingActionId) {
						throw new Error(`[reopenParentFromDelegation] Pending action mismatch for child ${childTaskId}`)
					}
					completingChild = { ...child }
					const lifecycleUpdate = completeDelegatedChild(historyItem, child, completionResultSummary)
					return {
						...lifecycleUpdate.child,
						pendingAction:
							child.pendingAction?.actionId === pendingActionId ? undefined : child.pendingAction,
					}
				},
				(parent) => {
					const lifecycleUpdate = completeDelegatedChild(parent, completingChild, completionResultSummary)
					updatedHistory = lifecycleUpdate.parent
					return updatedHistory
				},
			)
			this.recentTasksCache = undefined

			// Terminal invalidation at the EXACT durable commit boundary — the
			// child is completed as of the atomic pair write above and can never
			// be the publication target again. It runs synchronously before any
			// further await, so a parent reconstruction/resume failure below
			// cannot retain the child's projection-target registration: a
			// deferred projection settlement arriving afterwards fails the
			// exact-token relevance fence instead of resurrecting stale or
			// explicit-clear state for the completed child. (Nothing is cleared
			// before this point: on an aborted pre-commit path the child is
			// still active and its in-flight projection remains meaningful.)
			this.invalidateProviderHandoffProjectionState(childTaskId)

			// Notify the webview of both updated items so its in-memory history stays current.
			if (this.isViewLaunched) {
				const updatedChild = this.taskHistoryStore.get(childTaskId)
				const updatedParent = this.taskHistoryStore.get(parentTaskId)
				if (updatedChild) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedChild })
				}
				if (updatedParent) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedParent })
				}
			}

			// 6) Emit TaskDelegationCompleted (provider-level)
			try {
				this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
			} catch {
				// non-fatal
			}

			// 7) Reopen the parent from history as the sole active task (restores saved mode)
			//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
			//    The transition owner proves this restoration already holds the
			//    parent's transition lock, so a same-parent interruption triggered
			//    by the eviction inside runs its unlocked core instead of
			//    deadlocking on the lock we hold. Other parents still acquire
			//    their own locks normally.
			const parentInstance = await this.createTaskWithHistoryItem(updatedHistory, {
				startTask: false,
				transitionOwner,
			})

			// 8) Inject restored histories into the in-memory instance before resuming
			if (parentInstance) {
				try {
					await parentInstance.overwriteClineMessages(parentClineMessages, false)
				} catch {
					// non-fatal
				}
				try {
					await parentInstance.overwriteApiConversationHistory(parentApiMessages, false)
				} catch {
					// non-fatal
				}

				// Auto-resume parent without ask("resume_task")
				await parentInstance.resumeAfterDelegation()
			}

			// 9) Emit TaskDelegationResumed (provider-level)
			try {
				this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
			} catch {
				// non-fatal
			}

			this.cancelledDelegationChildIds.delete(childTaskId)
			// The child's publication markers were already invalidated at the
			// durable commit boundary above.
			return true
		})
	}

	/**
	 * Explicitly sever a delegated parent-child link, e.g. when the user gives up on
	 * an "interrupted" subtask instead of resuming it. Unlike removeClineFromStack()'s
	 * automatic repair, this is user-initiated and works even while the child is
	 * "interrupted" (which removeClineFromStack intentionally leaves alone so the child
	 * can still resume and report back). Only interrupted children can be abandoned — a
	 * still-running child must be cancelled first, so its link is never severed mid-stream.
	 *
	 * Parent transitions delegated → active (its normal "no longer awaiting a child"
	 * state). The child's own status is left untouched (interrupted stays interrupted;
	 * VALID_TRANSITIONS only allows interrupted → completed) — only its parent/root
	 * links are cleared so a later resume-and-complete cannot reattach it.
	 */
	public async abandonSubtask(childTaskId: string): Promise<boolean> {
		const { historyItem: childHistory } = await this.getTaskWithId(childTaskId)
		const parentTaskId = childHistory.parentTaskId

		if (!parentTaskId) {
			return false
		}

		// Only an interrupted (cancelled, not running) child may be abandoned. A still-running
		// child must be cancelled first — severing the link out from under a live stream would
		// orphan it silently instead of giving the user the normal cancel/resume flow.
		if (childHistory.status !== "interrupted") {
			this.log(
				`[abandonSubtask] Aborting: child ${childTaskId} is not interrupted (status=${childHistory.status})`,
			)
			return false
		}

		return this.runDelegationTransition(parentTaskId, async () => {
			const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

			if (parentHistory?.status !== "delegated" || parentHistory?.awaitingChildId !== childTaskId) {
				this.log(
					`[abandonSubtask] Aborting: parent ${parentTaskId} is no longer delegated to child ${childTaskId} ` +
						`(status=${parentHistory?.status}, awaitingChildId=${parentHistory?.awaitingChildId})`,
				)
				return false
			}

			// Re-check inside the lock: the child may have been resumed (and be streaming again,
			// or have completed) between the check above and acquiring the delegation transition lock.
			const freshChild = this.taskHistoryStore.get(childTaskId)
			if (freshChild?.status !== "interrupted") {
				this.log(
					`[abandonSubtask] Aborting: child ${childTaskId} is no longer interrupted (status=${freshChild?.status})`,
				)
				return false
			}

			// Close the live child instance (if it's still the open task — the common case,
			// since an interrupted child is rehydrated onto the stack after cancelTask) BEFORE
			// clearing its persisted links. Task#saveClineMessages() rebuilds parentTaskId/
			// rootTaskId from the live (readonly) Task fields on every save, so any save that
			// happens after we clear the persisted links — including abortTask's own final
			// save — would silently reattach the child to its old parent.
			const current = this.getCurrentTask()
			if (current?.taskId === childTaskId) {
				await this.removeClineFromStack()
			}

			await this.taskHistoryStore.atomicUpdatePair(
				childTaskId,
				parentTaskId,
				(child) => abandonDelegatedChild(parentHistory, child).child,
				(parent) => abandonDelegatedChild(parent, freshChild).parent,
			)
			this.recentTasksCache = undefined

			// Guard against a stale in-flight resume/completion (e.g. a resume that was already
			// in progress when abandon was clicked) reattaching the child after the link above
			// was cleared. AttemptCompletionTool re-reads parent status from the persisted store,
			// not the live task's readonly parentTaskId field, so this is the authoritative gate.
			this.cancelledDelegationChildIds.add(childTaskId)

			// Terminal invalidation at the durable sever boundary: the link is
			// severed and the child left the provider, so its projection-target
			// registration and explicit-clear publication markers are dropped
			// synchronously before the state post below.
			this.invalidateProviderHandoffProjectionState(childTaskId)

			if (this.isViewLaunched) {
				const updatedChild = this.taskHistoryStore.get(childTaskId)
				const updatedParent = this.taskHistoryStore.get(parentTaskId)
				if (updatedChild) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedChild })
				}
				if (updatedParent) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedParent })
				}
			}

			this.log(`[abandonSubtask] Severed link between parent ${parentTaskId} and child ${childTaskId}`)
			return true
		})
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			console.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				console.error("Invalid file path provided for URI conversion:", error)
			} else {
				console.error("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}
}
