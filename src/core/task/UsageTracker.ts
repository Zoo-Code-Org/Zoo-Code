import debounce from "lodash.debounce"

import { type ClineMessage, type TokenUsage, type ToolName, type ToolUsage, RooCodeEventName } from "@roo-code/types"

import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"

type EmitTaskEvent = (event: RooCodeEventName, ...args: any[]) => boolean

export interface UsageTrackerOptions {
	taskId: string
	getMessages: () => ClineMessage[]
	emit: EmitTaskEvent
	emitIntervalMs?: number
}

const DEFAULT_TOKEN_USAGE_EMIT_INTERVAL_MS = 2000

export class UsageTracker {
	private readonly taskId: string
	private readonly getMessages: () => ClineMessage[]
	private readonly emit: EmitTaskEvent
	private readonly debouncedEmitTokenUsage: ReturnType<typeof debounce>

	private tokenUsageSnapshot?: TokenUsage
	private toolUsageSnapshot?: ToolUsage
	private currentToolUsage: ToolUsage = {}

	constructor({
		taskId,
		getMessages,
		emit,
		emitIntervalMs = DEFAULT_TOKEN_USAGE_EMIT_INTERVAL_MS,
	}: UsageTrackerOptions) {
		this.taskId = taskId
		this.getMessages = getMessages
		this.emit = emit

		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates
		this.debouncedEmitTokenUsage = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			emitIntervalMs,
			{ leading: true, trailing: true, maxWait: emitIntervalMs },
		)
	}

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.getMessages().slice(1)))
	}

	public emitTokenUsageUpdate(tokenUsage: TokenUsage): void {
		this.debouncedEmitTokenUsage(tokenUsage, this.currentToolUsage)
	}

	public emitFinalTokenUsageUpdate(): void {
		this.emitTokenUsageUpdate(this.getTokenUsage())
		this.debouncedEmitTokenUsage.flush()
	}

	public dispose(): void {
		this.debouncedEmitTokenUsage.cancel()
	}

	public recordToolUsage(toolName: ToolName): void {
		const usage = this.ensureToolUsageEntry(toolName)
		usage.attempts++
	}

	public recordToolError(toolName: ToolName, error?: string): void {
		const usage = this.ensureToolUsageEntry(toolName)
		usage.failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	public get toolUsage(): ToolUsage {
		return this.currentToolUsage
	}

	public set toolUsage(toolUsage: ToolUsage) {
		this.currentToolUsage = toolUsage
	}

	public get tokenUsage(): TokenUsage {
		return this.getTokenUsage()
	}

	private ensureToolUsageEntry(toolName: ToolName): { attempts: number; failures: number } {
		if (!this.currentToolUsage[toolName]) {
			this.currentToolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		return this.currentToolUsage[toolName]!
	}
}
