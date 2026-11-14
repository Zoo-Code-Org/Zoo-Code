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

	renew(path: string, revision: string): void {
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
	}

	isCurrent(path: string, revision: string): boolean {
		const current = this.revisions.get(path)
		return current?.revision === revision && !current.controller.signal.aborted
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
