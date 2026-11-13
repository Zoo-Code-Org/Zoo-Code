import type { HistoryItem, ProviderSettings, TokenUsage } from "@roo-code/types"

import { fallbackTitle, generateTaskTitle, type GenerateTaskTitleOptions } from "./generateTaskTitle"

export const TASK_TITLE_MAX_CONCURRENT = 2

export interface TaskTitleSettings {
	enabled: boolean
	/** Provider profile used for title requests; unset means "use the task's own profile". */
	apiConfigId?: string
	customSupportPrompts?: Record<string, string | undefined>
}

/** The slice of a live task the service needs. */
export interface TaskTitleTask {
	taskId: string
	parentTaskId?: string
	apiConfiguration: ProviderSettings
}

export interface TaskTitleServiceDeps {
	getHistoryItem(taskId: string): HistoryItem | undefined
	setAutoTitle(taskId: string, autoTitle: string): Promise<void>
	getSettings(): Promise<TaskTitleSettings>
	/** Resolve a saved provider profile by id; `undefined` when it no longer exists. */
	resolveProfile(apiConfigId: string): Promise<ProviderSettings | undefined>
	/** Whether the current organization policy allows sending the prompt to this profile. */
	isProfileAllowed(profile: ProviderSettings): Promise<boolean>
	generate?(options: GenerateTaskTitleOptions): Promise<string | undefined>
	log?(message: string): void
}

type CancelReason = "user" | "deleted" | "disposed"

interface Job {
	taskId: string
	task: TaskTitleTask
	controller: AbortController
	cancelReason?: CancelReason
}

/**
 * Generates a short display title for new root tasks in the background, after the task's first
 * API response. It never blocks the task, never reports errors to the chat, and never touches
 * the rate-limit clock. Titles are written only through `setAutoTitle`, which re-checks the
 * persisted record under the store lock.
 */
export class TaskTitleService {
	private readonly candidates = new Map<string, TaskTitleTask>()
	private readonly jobs = new Map<string, Job>()
	private readonly queue: Job[] = []
	private running = 0
	private disposed = false

	constructor(private readonly deps: TaskTitleServiceDeps) {}

	/** Register a newly created task. Resumed tasks and subtasks are never candidates. */
	onTaskCreated(task: TaskTitleTask): void {
		if (this.disposed || task.parentTaskId || this.deps.getHistoryItem(task.taskId)) {
			return
		}
		// Copy the fields so an unscheduled candidate does not keep the live task alive.
		const { taskId, parentTaskId, apiConfiguration } = task
		this.candidates.set(taskId, { taskId, parentTaskId, apiConfiguration })
	}

	/**
	 * Drop a task that left the stack before its first API usage. A title request that is already
	 * scheduled keeps running, so switching tasks does not lose it.
	 */
	forget(taskId: string): void {
		this.candidates.delete(taskId)
	}

	/** Called on every token-usage update; schedules once, after the first real API usage. */
	onTokenUsageUpdated(taskId: string, tokenUsage: Pick<TokenUsage, "totalTokensIn">): void {
		if (tokenUsage.totalTokensIn > 0) {
			this.schedule(taskId)
		}
	}

	schedule(taskId: string): void {
		const task = this.candidates.get(taskId)
		if (this.disposed || !task) {
			return
		}
		this.candidates.delete(taskId)

		const job: Job = { taskId, task, controller: new AbortController() }
		this.jobs.set(taskId, job)
		this.queue.push(job)
		this.drain()
	}

	/**
	 * "user": stop the request and record the free fallback title.
	 * "deleted": stop the request and record nothing.
	 */
	cancel(taskId: string, reason: Exclude<CancelReason, "disposed">): void {
		this.candidates.delete(taskId)

		const job = this.jobs.get(taskId)
		if (!job || job.cancelReason) {
			return
		}
		job.cancelReason = reason
		job.controller.abort()

		const queuedAt = this.queue.indexOf(job)
		if (queuedAt >= 0) {
			this.queue.splice(queuedAt, 1)
			this.jobs.delete(taskId)
			if (reason === "user") {
				void this.finishQueuedCancellation(job)
			}
		}
	}

	dispose(): void {
		this.disposed = true
		this.candidates.clear()
		this.queue.length = 0
		for (const job of this.jobs.values()) {
			job.cancelReason = "disposed"
			job.controller.abort()
		}
		this.jobs.clear()
	}

	private drain(): void {
		while (this.running < TASK_TITLE_MAX_CONCURRENT) {
			const job = this.queue.shift()
			if (!job) {
				return
			}
			this.running++
			void this.run(job)
				.catch((error: unknown) => this.log(`[TaskTitleService] ${job.taskId}: ${errorMessage(error)}`))
				.finally(() => {
					this.running--
					if (this.jobs.get(job.taskId) === job) {
						this.jobs.delete(job.taskId)
					}
					this.drain()
				})
		}
	}

	private async finishQueuedCancellation(job: Job): Promise<void> {
		try {
			const prepared = await this.prepare(job)
			if (prepared) {
				await this.record(job.taskId, fallbackTitle(prepared.prompt))
			}
		} catch (error) {
			this.log(`[TaskTitleService] ${job.taskId}: ${errorMessage(error)}`)
		}
	}

	/** Runs the pre-flight checks; `undefined` means nothing should be generated or recorded. */
	private async prepare(job: Job): Promise<{ prompt: string; settings: TaskTitleSettings } | undefined> {
		const settings = await this.deps.getSettings()
		if (!settings.enabled) {
			return undefined
		}

		const item = this.deps.getHistoryItem(job.taskId)
		if (!item || item.title || item.autoTitle) {
			return undefined
		}
		return { prompt: item.task, settings }
	}

	private async run(job: Job): Promise<void> {
		const prepared = await this.prepare(job)
		if (!prepared || isDropped(job)) {
			return
		}
		const { prompt, settings } = prepared
		const taskProfile = job.task.apiConfiguration

		let title: string | undefined
		// A failed profile lookup or policy check falls through to the fallback title, like a failed request.
		try {
			const titleProfile = settings.apiConfigId ? await this.deps.resolveProfile(settings.apiConfigId) : undefined
			const profile = titleProfile ?? taskProfile
			const rateLimited = (taskProfile.rateLimitSeconds ?? 0) > 0 || (titleProfile?.rateLimitSeconds ?? 0) > 0
			// Checked per request: the organization policy may have changed since the task started.
			// Cancellation is re-checked after the await so a cancel during the check sends no request.
			if (!rateLimited && (await this.deps.isProfileAllowed(profile)) && !job.cancelReason) {
				title = await (this.deps.generate ?? generateTaskTitle)({
					profile,
					prompt,
					customSupportPrompts: settings.customSupportPrompts,
					signal: job.controller.signal,
				})
			}
		} catch (error) {
			this.log(`[TaskTitleService] ${job.taskId}: title request failed: ${errorMessage(error)}`)
		}

		if (isDropped(job)) {
			return
		}
		// A late result after a user cancellation is discarded in favor of the free fallback.
		await this.record(job.taskId, (!job.controller.signal.aborted && title) || fallbackTitle(prompt))
	}

	private async record(taskId: string, title: string): Promise<void> {
		if (this.disposed || !title.trim()) {
			return
		}
		await this.deps.setAutoTitle(taskId, title)
	}

	private log(message: string): void {
		this.deps.log?.(message)
	}
}

/** Cancelled by deletion or disposal: nothing may be recorded for the task. */
function isDropped(job: Job): boolean {
	return job.cancelReason === "deleted" || job.cancelReason === "disposed"
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
