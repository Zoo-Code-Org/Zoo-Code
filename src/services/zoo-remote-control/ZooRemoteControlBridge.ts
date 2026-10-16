import * as vscode from "vscode"

import {
	classifyRemoteControlHttpResult,
	executeRemoteCommand,
	generateZooRemoteInstanceId,
	isZooRemoteControlEligible,
	partialFlushDecision,
	projectClineMessageForRemote,
	projectClineMessagesForSnapshot,
	remoteMessageKey,
	requeueRemoteEventsKeepingNewest,
	resolveRemoteMessageAction,
	resolveZooRemoteEventSeq,
	setZooRemoteControlAvailable,
	workspaceNicknameFromFsPath,
	ZooRemoteControlClient,
	type ZooRemoteCommand,
	type ZooRemoteEvent,
} from "@roo-code/core"
import {
	providerIdentifiers,
	RooCodeEventName,
	type ClineMessage,
	type ProviderSettings,
	type RooCodeAPI,
} from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { Package } from "../../shared/package"
import { getCachedZooCodeToken, getZooCodeBaseUrl } from "../zoo-code-auth"

const PRESENCE_INTERVAL_MS = 15_000
const COMMAND_POLL_INTERVAL_MS = 2_000
const EVENT_FLUSH_INTERVAL_MS = 100
const PARTIAL_EVENT_MIN_INTERVAL_MS = 75
const UNAVAILABLE_BACKOFF_MS = 60_000
const NOT_ELIGIBLE_BACKOFF_MS = 30_000
const INSTANCE_ID_STATE_KEY = "zooRemoteControl.instanceId"
const EVENT_SEQ_STATE_KEY = "zooRemoteControl.eventSeq"
/** Built-in remote session flag (not a VS Code Configuration setting). */
const SESSION_ACTIVE_STATE_KEY = "zooRemoteControl.sessionActive"
const LEGACY_SETTING_KEY = "remoteControl.enabled"

export type ZooRemoteControlBridgeDeps = {
	api: Pick<RooCodeAPI, "on" | "off" | "sendMessage" | "cancelCurrentTask" | "resumeTask" | "startNewTask">
	provider: ClineProvider
	context: vscode.ExtensionContext
	log?: (message: string) => void
	client?: ZooRemoteControlClient
	now?: () => number
}

/** Publishes task UI events to Zoo and applies inbound remote commands when eligible. */
export class ZooRemoteControlBridge implements vscode.Disposable {
	private readonly api: ZooRemoteControlBridgeDeps["api"]
	private readonly provider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly log: (message: string) => void
	private readonly client: ZooRemoteControlClient
	private readonly now: () => number
	private readonly instanceId: string

	private disposed = false
	private active = false
	private serverAvailable = true
	private lastPostedAvailability: boolean | undefined
	private unavailableUntil = 0
	private eventSeq: number
	private pendingEvents: ZooRemoteEvent[] = []
	private lastPartialFlushAt = 0
	private pendingPartials = new Map<string, { taskId: string; action?: string; message: ClineMessage }>()
	/** Resolves true once instance id is durable in globalState (or already was). */
	private readonly identityReady: Promise<boolean>
	/** Serializes event-seq writes so updates cannot complete out of order. */
	private eventSeqPersistChain: Promise<void> = Promise.resolve()
	private eventSeqPersistFailed = false
	/** Bumped on deactivate/dispose so in-flight polls/flushes become no-ops. */
	private lifecycleEpoch = 0
	private commandPollInFlight = false
	/** At-most-once delivery for remote commands (esp. start_task) within an active session. */
	private handledCommandIds = new Set<string>()

	private presenceTimer: ReturnType<typeof setInterval> | undefined
	private commandTimer: ReturnType<typeof setInterval> | undefined
	private flushTimer: ReturnType<typeof setInterval> | undefined
	private readonly disposables: vscode.Disposable[] = []

	private readonly onMessage = (payload: { taskId: string; action?: string; message: ClineMessage }) => {
		void this.handleMessageEvent(payload)
	}

	private taskEventHandler(type: ZooRemoteEvent["type"]) {
		return (taskId: string) => {
			this.enqueueEvent({ type, taskId, timestamp: this.now() })
		}
	}

	private readonly onTaskInteractive = this.taskEventHandler("task_interactive")
	private readonly onTaskIdle = this.taskEventHandler("task_idle")
	private readonly onTaskResumable = this.taskEventHandler("task_resumable")
	private readonly onTaskCompleted = this.taskEventHandler("task_completed")
	private readonly onTaskAborted = this.taskEventHandler("task_aborted")

	private readonly onModeSwitched = (taskId: string, mode: string) => {
		this.enqueueEvent({ type: "mode_switched", taskId, mode, timestamp: this.now() })
	}

	private readonly onProviderProfileChanged = () => {
		void this.syncActiveState()
	}

	constructor(deps: ZooRemoteControlBridgeDeps) {
		this.api = deps.api
		this.provider = deps.provider
		this.context = deps.context
		this.log = deps.log ?? (() => {})
		this.now = deps.now ?? (() => Date.now())
		const identity = this.resolveInstanceId()
		this.instanceId = identity.id
		this.identityReady = identity.needsPersist ? this.persistInstanceId(identity.id) : Promise.resolve(true)
		this.eventSeq = this.resolveEventSeq()
		this.client =
			deps.client ??
			new ZooRemoteControlClient({
				getBaseUrl: getZooCodeBaseUrl,
				getSessionToken: getCachedZooCodeToken,
				log: this.log,
			})

		if (typeof this.provider.on === "function") {
			this.provider.on(RooCodeEventName.ProviderProfileChanged, this.onProviderProfileChanged)
		}

		if (typeof this.context.secrets?.onDidChange === "function") {
			this.disposables.push(
				this.context.secrets.onDidChange((event) => {
					if (event.key === "zoo-code-session-token") {
						void this.syncActiveState()
					}
				}),
			)
		}

		void this.migrateLegacySettingThenSync()
	}

	/** Test helper / webview: whether the user has an active remote session. */
	public isSessionActive(): boolean {
		return this.context.globalState.get<boolean>(SESSION_ACTIVE_STATE_KEY) === true
	}

	/** Start or end remote session (does not cancel the task). */
	public async setSessionActive(active: boolean): Promise<void> {
		await this.context.globalState.update(SESSION_ACTIVE_STATE_KEY, active)
		await this.syncActiveState()
		await this.provider.postStateToWebview()
	}

	private async migrateLegacySettingThenSync(): Promise<void> {
		try {
			const existing = this.context.globalState.get<boolean>(SESSION_ACTIVE_STATE_KEY)
			if (existing === undefined) {
				const legacy =
					vscode.workspace.getConfiguration(Package.name).get<boolean>(LEGACY_SETTING_KEY, false) === true
				if (legacy) {
					await this.context.globalState.update(SESSION_ACTIVE_STATE_KEY, true)
					try {
						await vscode.workspace
							.getConfiguration(Package.name)
							.update(LEGACY_SETTING_KEY, undefined, vscode.ConfigurationTarget.Global)
					} catch {
						// Best-effort clear of the removed setting.
					}
				}
			}
		} catch (error) {
			this.log(
				`[ZooRemoteControl] legacy setting migrate failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		await this.syncActiveState()
	}

	/** Awaitable teardown so offline presence can finish before extension deactivate returns. */
	public async shutdown(): Promise<void> {
		if (this.disposed) {
			return
		}
		this.lifecycleEpoch += 1
		await this.deactivate({ notifyOffline: true })
		this.releaseResources()
	}

	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.lifecycleEpoch += 1
		void this.deactivate({ notifyOffline: true })
		this.releaseResources()
	}

	private releaseResources(): void {
		this.disposed = true
		setZooRemoteControlAvailable(false)
		if (typeof this.provider.off === "function") {
			this.provider.off(RooCodeEventName.ProviderProfileChanged, this.onProviderProfileChanged)
		}
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables.length = 0
	}

	private isLifecycleCurrent(epoch: number): boolean {
		return !this.disposed && this.active && epoch === this.lifecycleEpoch
	}

	/** Test helper */
	public isActive(): boolean {
		return this.active
	}

	/** Test helper */
	public getInstanceId(): string {
		return this.instanceId
	}

	private resolveInstanceId(): { id: string; needsPersist: boolean } {
		const existing = this.context.globalState.get<string>(INSTANCE_ID_STATE_KEY)
		if (existing) {
			return { id: existing, needsPersist: false }
		}
		return {
			id: generateZooRemoteInstanceId(this.now(), vscode.env.sessionId),
			needsPersist: true,
		}
	}

	private async persistInstanceId(id: string): Promise<boolean> {
		try {
			await this.context.globalState.update(INSTANCE_ID_STATE_KEY, id)
			return true
		} catch (error) {
			this.log(
				`[ZooRemoteControl] failed to persist instance id: ${error instanceof Error ? error.message : String(error)}`,
			)
			return false
		}
	}

	private resolveEventSeq(): number {
		return resolveZooRemoteEventSeq(this.context.globalState.get<number>(EVENT_SEQ_STATE_KEY))
	}

	private persistEventSeq(): void {
		this.eventSeqPersistChain = this.eventSeqPersistChain
			.then(async () => {
				if (this.disposed || this.eventSeqPersistFailed) {
					return
				}
				await this.context.globalState.update(EVENT_SEQ_STATE_KEY, this.eventSeq)
			})
			.catch((error: unknown) => {
				this.eventSeqPersistFailed = true
				this.pendingEvents = []
				this.log(
					`[ZooRemoteControl] failed to persist event seq: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
	}

	private getApiProvider(): string | undefined {
		try {
			const getSettings = this.provider.contextProxy?.getProviderSettings
			if (typeof getSettings !== "function") {
				return undefined
			}
			const settings: ProviderSettings = getSettings.call(this.provider.contextProxy)
			return settings?.apiProvider
		} catch {
			return undefined
		}
	}

	private evaluateEligible(): boolean {
		return isZooRemoteControlEligible({
			remoteControlEnabled: this.isSessionActive(),
			apiProvider: this.getApiProvider(),
			sessionToken: getCachedZooCodeToken() || undefined,
		})
	}

	private async syncActiveState(): Promise<void> {
		if (this.disposed) {
			return
		}

		try {
			const eligible = this.evaluateEligible()
			if (eligible && !this.active) {
				await this.activate()
			} else if (!eligible && this.active) {
				await this.deactivate({ notifyOffline: true })
			} else if (eligible && this.active) {
				await this.publishPresence(true)
			}
		} catch (error) {
			this.log(`[ZooRemoteControl] sync failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private async activate(): Promise<void> {
		if (this.active || this.disposed) {
			return
		}

		const identityOk = await this.identityReady
		if (!identityOk || this.disposed) {
			this.log("[ZooRemoteControl] refusing to activate: instance id is not persisted")
			return
		}

		this.active = true
		this.setServerAvailable(true)
		this.bindApiListeners(true)
		this.presenceTimer = setInterval(() => {
			void this.publishPresence(true)
		}, PRESENCE_INTERVAL_MS)
		this.commandTimer = setInterval(() => {
			void this.pollCommands()
		}, COMMAND_POLL_INTERVAL_MS)
		this.flushTimer = setInterval(() => {
			void this.flushEvents()
		}, EVENT_FLUSH_INTERVAL_MS)

		this.log("[ZooRemoteControl] enabled")
		await this.publishPresence(true)
		await this.publishSnapshot()
	}

	private async deactivate({ notifyOffline }: { notifyOffline: boolean }): Promise<void> {
		if (!this.active && !notifyOffline) {
			this.clearTimers()
			this.bindApiListeners(false)
			return
		}

		this.lifecycleEpoch += 1
		this.active = false
		this.clearTimers()
		this.bindApiListeners(false)
		this.pendingEvents = []
		this.pendingPartials.clear()
		this.handledCommandIds.clear()
		this.publishAvailabilityToWebview()

		if (notifyOffline) {
			// Always try offline presence while a session token remains (even if provider changed).
			await this.publishPresence(false, { force: true })
		}

		this.log("[ZooRemoteControl] disabled")
	}

	private clearTimers(): void {
		for (const key of ["presenceTimer", "commandTimer", "flushTimer"] as const) {
			const timer = this[key]
			if (timer) {
				clearInterval(timer)
				this[key] = undefined
			}
		}
	}

	private bindApiListeners(bind: boolean): void {
		const method = bind ? "on" : "off"
		this.api[method](RooCodeEventName.Message, this.onMessage)
		this.api[method](RooCodeEventName.TaskInteractive, this.onTaskInteractive)
		this.api[method](RooCodeEventName.TaskIdle, this.onTaskIdle)
		this.api[method](RooCodeEventName.TaskResumable, this.onTaskResumable)
		this.api[method](RooCodeEventName.TaskCompleted, this.onTaskCompleted)
		this.api[method](RooCodeEventName.TaskAborted, this.onTaskAborted)
		this.api[method](RooCodeEventName.TaskModeSwitched, this.onModeSwitched)
	}

	private async handleMessageEvent(payload: {
		taskId: string
		action?: string
		message: ClineMessage
	}): Promise<void> {
		if (!this.active) {
			return
		}

		const shaped = {
			taskId: payload.taskId,
			action: payload.action,
			message: projectClineMessageForRemote(payload.message),
		}

		const key = remoteMessageKey(shaped.taskId, shaped.message)
		if (shaped.message.partial === true) {
			this.pendingPartials.set(key, shaped)
			// Start the throttle window on the first partial without flushing so rapid
			// updates to the same message coalesce to the latest text.
			const decision = partialFlushDecision(this.lastPartialFlushAt, this.now(), PARTIAL_EVENT_MIN_INTERVAL_MS)
			if (decision === "arm") {
				this.lastPartialFlushAt = this.now()
				return
			}
			if (decision === "wait") {
				return
			}
			this.flushPendingPartials()
			return
		}

		this.pendingPartials.delete(key)
		this.enqueueMessageEvent(shaped)
	}

	private flushPendingPartials(): void {
		if (this.pendingPartials.size === 0) {
			return
		}
		this.lastPartialFlushAt = this.now()
		for (const shaped of this.pendingPartials.values()) {
			this.enqueueMessageEvent(shaped)
		}
		this.pendingPartials.clear()
	}

	private enqueueMessageEvent(shaped: { taskId: string; action?: string; message: ClineMessage }): void {
		this.enqueueEvent({
			type: "message",
			taskId: shaped.taskId,
			action: resolveRemoteMessageAction(shaped.action, shaped.message.partial),
			message: shaped.message,
			timestamp: this.now(),
		})
	}

	private enqueueEvent(event: Omit<ZooRemoteEvent, "seq">): void {
		if (!this.active || this.eventSeqPersistFailed) {
			return
		}

		this.pendingEvents.push({ ...event, seq: this.eventSeq++ })
		this.persistEventSeq()
	}

	private markBackoff(ms: number): void {
		this.serverAvailable = false
		this.unavailableUntil = this.now() + ms
		this.publishAvailabilityToWebview()
	}

	private setServerAvailable(available: boolean): void {
		this.serverAvailable = available
		if (available) {
			this.unavailableUntil = 0
		}
		this.publishAvailabilityToWebview()
	}

	private publishAvailabilityToWebview(): void {
		const available = this.active && this.canCallServer()
		if (this.lastPostedAvailability === available) {
			return
		}
		this.lastPostedAvailability = available
		setZooRemoteControlAvailable(available)
		void this.provider.postStateToWebview()
	}

	private canCallServer(): boolean {
		return this.serverAvailable || this.now() >= this.unavailableUntil
	}

	private async publishPresence(online: boolean, options?: { force?: boolean }): Promise<void> {
		if (!options?.force && !this.canCallServer() && online) {
			return
		}
		if (!getCachedZooCodeToken()) {
			return
		}

		// Nickname only — never send an absolute disk path (home dir / username fingerprint).
		const workspacePath = workspaceNicknameFromFsPath(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
		const taskId = this.provider.getCurrentTask()?.taskId
		const epoch = this.lifecycleEpoch
		const result = await this.client.postPresence({
			instanceId: this.instanceId,
			apiProvider: this.getApiProvider() ?? providerIdentifiers.zooGateway,
			workspacePath,
			taskId,
			online,
			editorName: vscode.env.appName,
			extensionVersion: Package.version,
		})

		// Online publishes must still belong to the active lifecycle. Offline notify is allowed
		// after deactivate (active=false) as long as a newer activation has not started.
		if (online) {
			if (!this.isLifecycleCurrent(epoch)) {
				return
			}
		} else if (this.active && epoch !== this.lifecycleEpoch) {
			return
		}

		const kind = classifyRemoteControlHttpResult(result)
		if (kind === "auth_blocked") {
			this.markBackoff(NOT_ELIGIBLE_BACKOFF_MS)
			if (this.active) {
				await this.deactivate({ notifyOffline: false })
			}
			return
		}
		if (kind === "unavailable") {
			this.markBackoff(UNAVAILABLE_BACKOFF_MS)
			return
		}
		if (kind === "success") {
			this.setServerAvailable(true)
		}
	}

	private async publishSnapshot(): Promise<void> {
		if (!this.active || !this.canCallServer()) {
			return
		}

		const task = this.provider.getCurrentTask()
		if (!task?.taskId || !Array.isArray(task.clineMessages)) {
			return
		}

		let mode: string | undefined
		try {
			mode = task.taskMode
		} catch {
			mode = undefined
		}

		const epoch = this.lifecycleEpoch
		const result = await this.client.postSnapshot({
			instanceId: this.instanceId,
			taskId: task.taskId,
			messages: projectClineMessagesForSnapshot(task.clineMessages),
			mode,
		})
		if (!this.isLifecycleCurrent(epoch)) {
			return
		}

		const kind = classifyRemoteControlHttpResult(result)
		if (kind === "auth_blocked") {
			this.markBackoff(NOT_ELIGIBLE_BACKOFF_MS)
			return
		}
		if (kind === "unavailable") {
			this.markBackoff(UNAVAILABLE_BACKOFF_MS)
			return
		}
		if (kind === "success") {
			this.setServerAvailable(true)
		}
	}

	private async flushEvents(): Promise<void> {
		if (!this.active || this.eventSeqPersistFailed || !this.canCallServer()) {
			return
		}

		const epoch = this.lifecycleEpoch
		this.flushPendingPartials()
		if (this.pendingEvents.length === 0) {
			return
		}

		const batch = this.pendingEvents.splice(0, this.pendingEvents.length)
		const result = await this.client.postEvents(this.instanceId, batch)
		if (!this.isLifecycleCurrent(epoch)) {
			return
		}

		const kind = classifyRemoteControlHttpResult(result)
		if (kind === "auth_blocked") {
			this.markBackoff(NOT_ELIGIBLE_BACKOFF_MS)
			// Keep the failed batch ahead of anything enqueued during the await; cap from the
			// tail so the newest events survive under pressure.
			this.pendingEvents = requeueRemoteEventsKeepingNewest(batch, this.pendingEvents)
			return
		}
		if (kind === "unavailable") {
			this.markBackoff(UNAVAILABLE_BACKOFF_MS)
			// Drop batch while the public endpoint is not available yet.
			return
		}
		if (kind === "failed") {
			this.pendingEvents = requeueRemoteEventsKeepingNewest(batch, this.pendingEvents)
			return
		}
		this.setServerAvailable(true)
	}

	private async pollCommands(): Promise<void> {
		if (!this.active || this.disposed || this.commandPollInFlight || !this.canCallServer()) {
			return
		}

		if (!this.evaluateEligible()) {
			await this.deactivate({ notifyOffline: true })
			return
		}

		this.commandPollInFlight = true
		const epoch = this.lifecycleEpoch
		try {
			const result = await this.client.getCommands(this.instanceId)
			if (!this.isLifecycleCurrent(epoch)) {
				return
			}

			const kind = classifyRemoteControlHttpResult(result)
			if (kind === "auth_blocked") {
				this.markBackoff(NOT_ELIGIBLE_BACKOFF_MS)
				await this.deactivate({ notifyOffline: false })
				return
			}
			if (kind === "unavailable") {
				this.markBackoff(UNAVAILABLE_BACKOFF_MS)
				return
			}
			if (kind !== "success" || !result.body) {
				return
			}

			this.setServerAvailable(true)

			for (const command of result.body.commands) {
				if (!this.isLifecycleCurrent(epoch)) {
					return
				}
				await this.executeCommand(command, epoch)
			}
		} finally {
			this.commandPollInFlight = false
		}
	}

	private async executeCommand(command: ZooRemoteCommand, epoch: number): Promise<void> {
		await executeRemoteCommand({
			command,
			epoch,
			client: this.client,
			handledCommandIds: this.handledCommandIds,
			host: {
				isLifecycleCurrent: (value) => this.isLifecycleCurrent(value),
				isEligible: () => this.evaluateEligible(),
				sendMessage: (text, images) => this.api.sendMessage(text, images),
				handleModeSwitch: (mode) => this.provider.handleModeSwitch(mode),
				getCurrentTask: () => {
					const task = this.provider.getCurrentTask()
					if (!task) {
						return undefined
					}
					return {
						taskId: task.taskId,
						hasPendingAsk: () => task.hasPendingAsk(),
						approveAsk: (payload) => task.approveAsk(payload),
						denyAsk: (payload) => task.denyAsk(payload),
					}
				},
				cancelCurrentTask: () => this.api.cancelCurrentTask(),
				resumeTask: (taskId) => this.api.resumeTask(taskId),
				startNewTask: async (payload) => {
					await this.api.startNewTask(payload)
				},
				endRemoteSession: () => this.setSessionActive(false),
			},
		})
	}
}
