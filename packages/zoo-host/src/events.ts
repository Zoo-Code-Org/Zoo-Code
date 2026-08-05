import type { RooCodeAPI, HeadlessTaskResult } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import { ZOO_PUBLIC_SCHEMA_VERSION, type ZooStreamEvent } from "@roo-code/zoo-protocol"

import { HostTransport } from "./transport.js"

export class HostEventBridge {
	private publicSequence = 0
	private readonly roots = new Map<string, string>()
	private readonly startedAt = new Map<string, number>()
	private readonly pendingCreated = new Set<string>()
	private readonly initiatingRequests = new Map<string, string>()
	private readonly approvalModes = new Map<string, "interactive" | "safe" | "auto">()
	private readonly pendingAsks = new Map<string, { askId: string; subject: string }>()
	private readonly pendingResponses = new Map<
		string,
		{ requestId: string; askId: string; decision: "approve" | "reject" | "needs_input" }
	>()
	private readonly cancellationRequests = new Map<string, string>()
	private readonly startedTasks = new Set<string>()
	private eventQueue = Promise.resolve()
	private pendingInitiation:
		| { type: "start"; requestId: string; approval: "interactive" | "safe" | "auto" }
		| {
				type: "resume"
				requestId: string
				approval: "interactive" | "safe" | "auto"
				taskId: string
				rootTaskId: string
				previousState: "waiting" | "interrupted"
		  }
		| undefined

	constructor(
		private readonly api: RooCodeAPI,
		private readonly transport: HostTransport,
		private readonly workspace: string,
		private readonly clientVersion: string,
		private readonly hostVersion: string,
	) {}

	public prepareStart(requestId: string, approval: "interactive" | "safe" | "auto"): void {
		this.pendingInitiation = { type: "start", requestId, approval }
	}

	public prepareResume(
		requestId: string,
		taskId: string,
		rootTaskId: string,
		approval: "interactive" | "safe" | "auto",
		previousState: "waiting" | "interrupted",
	): void {
		this.pendingInitiation = { type: "resume", requestId, taskId, rootTaskId, approval, previousState }
	}

	public prepareAskResponse(
		requestId: string,
		taskId: string,
		askId: string,
		decision: "approve" | "reject" | "needs_input",
	): void {
		this.pendingResponses.set(taskId, { requestId, askId, decision })
	}

	public prepareCancellation(requestId: string, rootTaskId: string): void {
		this.cancellationRequests.set(rootTaskId, requestId)
	}

	public async initialize(): Promise<void> {
		await this.emit({
			type: "system.init",
			protocol: "zoo-stream",
			hostProtocolVersion: 1,
			capabilities: [
				"task:start",
				"task:resume",
				"task:input",
				"task:cancel",
				"ask:respond",
				"history:list",
				"host:snapshot",
				"host:shutdown",
				"checkpoint:unavailable",
			],
			clientVersion: this.clientVersion,
			hostVersion: this.hostVersion,
		})
		this.api.on(RooCodeEventName.TaskCreated, (taskId) => {
			this.pendingCreated.add(taskId)
		})
		this.api.on(RooCodeEventName.TaskStarted, (taskId) => {
			let creation:
				| { requestId?: string; rootTaskId: string; previousState?: "waiting" | "interrupted" }
				| undefined
			if (this.pendingCreated.delete(taskId)) {
				const initiation = this.pendingInitiation
				const rootTaskId = initiation?.type === "resume" ? initiation.rootTaskId : taskId
				this.roots.set(taskId, rootTaskId)
				if (initiation) {
					this.initiatingRequests.set(rootTaskId, initiation.requestId)
					this.approvalModes.set(rootTaskId, initiation.approval)
				}
				creation = {
					requestId: initiation?.requestId,
					rootTaskId,
					previousState: initiation?.type === "resume" ? initiation.previousState : undefined,
				}
				this.pendingInitiation = undefined
			}
			this.startedAt.set(this.roots.get(taskId) ?? taskId, Date.now())
			this.enqueue(async () => {
				if (creation) {
					await this.emitTask("task.created", taskId, { requestId: creation.requestId }, creation.rootTaskId)
					if (creation.previousState) {
						await this.emitTask(
							"task.lifecycle",
							taskId,
							{ state: creation.previousState },
							creation.rootTaskId,
						)
						await this.emitTask(
							"task.resumed",
							taskId,
							{ requestId: creation.requestId, previousState: creation.previousState },
							creation.rootTaskId,
						)
					}
				}
				if (!this.startedTasks.has(taskId)) {
					this.startedTasks.add(taskId)
					await this.emitTask("task.started", taskId, {})
				}
			})
		})
		this.api.on(RooCodeEventName.TaskDelegated, (parentTaskId, childTaskId) => {
			const rootTaskId = this.roots.get(parentTaskId) ?? parentTaskId
			this.roots.set(childTaskId, rootTaskId)
			const created = this.pendingCreated.delete(childTaskId)
			this.enqueue(async () => {
				if (created) await this.emitTask("task.created", childTaskId, { parentTaskId }, rootTaskId)
				await this.emitTask("task.delegated", childTaskId, { parentTaskId, childTaskId }, rootTaskId)
			})
		})
		this.api.on(RooCodeEventName.TaskCompleted, (taskId) => {
			const rootTaskId = this.roots.get(taskId)
			if (rootTaskId && taskId !== rootTaskId) {
				this.enqueue(() => this.emitTask("task.lifecycle", taskId, { state: "completed" }, rootTaskId))
			}
		})
		this.api.on(RooCodeEventName.Message, ({ taskId, message }) => {
			if (message.type !== "say" || !message.say || message.say === "api_req_started") return
			const role = message.say === "reasoning" ? "reasoning" : "assistant"
			this.enqueue(() =>
				this.emitTask("message.upsert", taskId, {
					messageId: String(message.ts),
					role,
					content: message.text ?? "",
					complete: message.partial !== true,
				}),
			)
		})
		this.api.on(RooCodeEventName.HeadlessAsk, (ask) => {
			this.roots.set(ask.taskId, ask.rootTaskId)
			this.pendingAsks.set(ask.taskId, { askId: ask.askId, subject: ask.text ?? ask.ask })
			this.enqueue(async () => {
				await this.emitTask(
					"ask.required",
					ask.taskId,
					{ askId: ask.askId, category: ask.ask, subject: ask.text ?? ask.ask },
					ask.rootTaskId,
				)
				await this.emitTask("task.lifecycle", ask.taskId, { state: "waiting" }, ask.rootTaskId)
				if (this.approvalModes.get(ask.rootTaskId) !== "interactive") {
					await this.api.settleHeadlessNeedsInput({
						rootTaskId: ask.rootTaskId,
						taskId: ask.taskId,
						content: ask.text ?? ask.ask,
					})
				}
			})
		})
		this.api.on(RooCodeEventName.TaskAskResponded, (taskId) => {
			const response = this.pendingResponses.get(taskId)
			if (!response) return
			this.pendingResponses.delete(taskId)
			this.pendingAsks.delete(taskId)
			this.enqueue(async () => {
				await this.emitTask("ask.resolved", taskId, {
					requestId: response.requestId,
					askId: response.askId,
					decision: response.decision,
					source: "user",
				})
				await this.emitTask("task.lifecycle", taskId, { state: "running", requestId: response.requestId })
			})
		})
		this.api.on(RooCodeEventName.HeadlessTaskResult, (result) => this.enqueue(() => this.emitResult(result)))
	}

	public recordTaskInput(requestId: string, taskId: string, text: string): void {
		this.enqueue(async () => {
			await this.emitTask("message.upsert", taskId, {
				requestId,
				messageId: `input-${requestId}`,
				role: "user",
				content: text,
				complete: true,
			})
			await this.emitTask("task.lifecycle", taskId, { requestId, state: "running" })
		})
	}

	private enqueue(operation: () => Promise<void>): void {
		this.eventQueue = this.eventQueue.then(operation).catch(() => undefined)
	}

	private async emitResult(event: {
		rootTaskId: string
		currentTaskId: string
		outcome: "completed" | "needs_input" | "cancelled" | "failed"
		resumable: boolean
		cancellationReason?: "user" | "signal" | "timeout"
		content?: string
	}): Promise<void> {
		const detailed = (await this.api.getHeadlessTaskResult(event.rootTaskId)) as HeadlessTaskResult | undefined
		const outcome = event.outcome
		const pendingAsk = this.pendingAsks.get(event.currentTaskId)
		if (pendingAsk && outcome !== "needs_input") {
			await this.emitTask(
				"ask.abandoned",
				event.currentTaskId,
				{
					askId: pendingAsk.askId,
					reason: outcome === "failed" ? "failed" : "cancelled",
				},
				event.rootTaskId,
			)
			this.pendingAsks.delete(event.currentTaskId)
		}
		if (outcome !== "needs_input") {
			await this.emitTask(
				"task.lifecycle",
				event.currentTaskId,
				{
					state: outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "interrupted",
					cause: outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : undefined,
				},
				event.rootTaskId,
			)
		}
		await this.emit({
			type: "task.result",
			requestId: this.cancellationRequests.get(event.rootTaskId) ?? this.initiatingRequests.get(event.rootTaskId),
			rootTaskId: event.rootTaskId,
			taskId: event.rootTaskId,
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: outcome === "completed",
				outcome,
				rootTaskId: event.rootTaskId,
				currentTaskId: event.currentTaskId,
				workspace: this.workspace,
				resumable: event.resumable,
				content: event.content ?? detailed?.content,
				error:
					outcome === "failed"
						? {
								code:
									detailed?.error?.code === "shutdown"
										? "task_failed"
										: (detailed?.error?.code ?? "task_failed"),
								message: detailed?.error?.message ?? "Task failed",
								kind: "runtime",
							}
						: undefined,
				usage: detailed?.tokenUsage
					? {
							inputTokens: detailed.tokenUsage.totalTokensIn,
							outputTokens: detailed.tokenUsage.totalTokensOut,
							cacheReads: detailed.tokenUsage.totalCacheReads,
							cacheWrites: detailed.tokenUsage.totalCacheWrites,
						}
					: undefined,
				cost: detailed?.tokenUsage?.totalCost,
				elapsedMs: Date.now() - (this.startedAt.get(event.rootTaskId) ?? Date.now()),
				cancellationReason:
					outcome === "cancelled"
						? (detailed?.cancellationReason ?? event.cancellationReason ?? "user")
						: undefined,
			},
		})
		this.startedAt.delete(event.rootTaskId)
		this.cancellationRequests.delete(event.rootTaskId)
	}

	private emitTask(type: string, taskId: string, data: Record<string, unknown>, rootTaskId?: string): Promise<void> {
		return this.emit({ type, rootTaskId: rootTaskId ?? this.roots.get(taskId) ?? taskId, taskId, ...data })
	}

	private async emit(event: Record<string, unknown>): Promise<void> {
		const normalized = {
			v: ZOO_PUBLIC_SCHEMA_VERSION,
			seq: ++this.publicSequence,
			timestamp: new Date().toISOString(),
			hostId: this.transport.hostId,
			...event,
		} as ZooStreamEvent
		await this.transport.send({ type: "event", event: normalized })
	}
}
