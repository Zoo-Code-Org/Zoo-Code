import type { Disposable, Event } from "vscode"
import type { IndexingErrorClassification } from "./shared/indexing-errors"
import type { RetryBudget, RetryFailure } from "./shared/retry-policy"

export type FileFailureActivity = "read" | "parse" | "embed" | "upsert" | "delete"
export type FileFailureState = "retrying" | "exhausted"
export const REMOVAL_REVISION = "removed"
export const UNKNOWN_REVISION = "unread"

export interface FailedFile {
	path: string
	revision: string
	activity: FileFailureActivity
	reason: string
	classification: IndexingErrorClassification
	attempt: number
	state: FileFailureState
	delayMs?: number
	delaySource?: RetryFailure["delaySource"]
}

type Revision = {
	revision: string
	controller: AbortController
	failures: Map<FileFailureActivity, FailedFile>
	budgets: Map<FileFailureActivity, RetryBudget>
}

export class FileFailureRegistry {
	private readonly entries = new Map<string, FailedFile>()
	private readonly revisions = new Map<string, Revision>()
	private readonly changes = new Set<() => void>()
	private readonly records = new Set<(failure: FailedFile) => void>()

	readonly onDidChange: Event<void> = (listener, thisArgument, disposables) => {
		const callback = () => listener.call(thisArgument, undefined)
		this.changes.add(callback)
		const disposable: Disposable = {
			dispose: () => {
				this.changes.delete(callback)
			},
		}
		disposables?.push(disposable)
		return disposable
	}

	readonly onDidRecord: Event<FailedFile> = (listener, thisArgument, disposables) => {
		const callback = (failure: FailedFile) => listener.call(thisArgument, { ...failure })
		this.records.add(callback)
		const disposable: Disposable = {
			dispose: () => {
				this.records.delete(callback)
			},
		}
		disposables?.push(disposable)
		return disposable
	}

	getRevision(path: string): string | undefined {
		return this.revisions.get(path)?.revision
	}

	get(path: string): FailedFile | undefined {
		const failure = this.entries.get(path)
		return failure && { ...failure }
	}

	has(path: string): boolean {
		return this.entries.has(path)
	}

	hasRevisionFailure(path: string, revision: string): boolean {
		const current = this.revisions.get(path)
		return current?.revision === revision && current.failures.size > 0
	}

	assertRetryable(path: string, revision: string): void {
		const current = this.revisions.get(path)
		if (current?.revision !== revision) return
		for (const failure of current.failures.values()) {
			if (failure.state === "exhausted") throw Object.assign(new Error(failure.reason), failure)
		}
	}

	renew(path: string, revision: string): AbortSignal {
		let current = this.revisions.get(path)
		if (!current || current.revision !== revision) {
			current?.controller.abort()
			current = { revision, controller: new AbortController(), failures: new Map(), budgets: new Map() }
			this.revisions.set(path, current)
			const failure = this.entries.get(path)
			if (failure) {
				this.entries.set(path, { ...failure, revision, state: "exhausted" })
				this.changed()
			}
		}
		return current.controller.signal
	}

	isCurrent(path: string, revision: string): boolean {
		const current = this.revisions.get(path)
		return current?.revision === revision && !current.controller.signal.aborted
	}

	getFailure(path: string, revision: string, activity: FileFailureActivity): FailedFile | undefined {
		const current = this.revisions.get(path)
		const failure = current?.revision === revision ? current.failures.get(activity) : undefined
		return failure && { ...failure }
	}

	getRetryBudget(path: string, revision: string, activity: FileFailureActivity): RetryBudget {
		const current = this.revisions.get(path)
		if (current?.revision !== revision) return { retriesUsed: 0 }
		let budget = current.budgets.get(activity)
		if (!budget) {
			budget = { retriesUsed: 0 }
			current.budgets.set(activity, budget)
		}
		return budget
	}

	isExhausted(path: string, revision: string, activity: FileFailureActivity): boolean {
		return this.getFailure(path, revision, activity)?.state === "exhausted"
	}

	record(
		path: string,
		revision: string,
		activity: FileFailureActivity,
		reason: string,
		attempt: number,
		state: FileFailureState,
		classification: IndexingErrorClassification = "permanent",
		delay?: Pick<RetryFailure, "delayMs" | "delaySource">,
	): void {
		if (!this.isCurrent(path, revision)) return
		const failure = { path, revision, activity, reason, attempt, state, classification, ...delay }
		this.revisions.get(path)!.failures.set(activity, failure)
		this.entries.set(path, failure)
		for (const listener of this.records) listener(failure)
		this.changed()
	}

	clear(path: string, revision?: string): void {
		if (revision !== undefined && !this.isCurrent(path, revision)) return
		this.revisions.get(path)?.failures.clear()
		this.revisions.get(path)?.budgets.clear()
		if (this.entries.delete(path)) this.changed()
	}

	resetAllBudgets(): void {
		for (const current of this.revisions.values()) {
			current.controller.abort()
			current.controller = new AbortController()
			current.failures.clear()
			current.budgets.clear()
		}
		for (const [path, failure] of this.entries) this.entries.set(path, { ...failure, state: "exhausted" })
		this.changed()
	}

	list(): FailedFile[] {
		return [...this.entries.values()].map((failure) => ({ ...failure }))
	}

	private changed(): void {
		for (const listener of this.changes) listener()
	}
}
