import { abortError, throwIfAborted } from "./parser-errors"
import { INDEX_STOP_LIMIT_MS } from "./constants"

export const LATE_WRITE_GRACE_MS = 30_000

type IssuedWrite = { pending: Promise<unknown>; files: string[]; abandoned?: boolean }

export class IndexWriteGate {
	private readonly issued = new Map<AbortSignal, Set<IssuedWrite>>()
	private readonly deadlines = new Map<string, number>()
	private readonly uncertainByAttempt = new WeakMap<AbortSignal, Set<string>>()
	private readonly owners = new WeakMap<AbortSignal, AbortSignal>()

	private readonly stopDeadlines = new WeakMap<AbortSignal, number>()
	private readonly observedOwners = new WeakSet<AbortSignal>()

	own(signal: AbortSignal, owner: AbortSignal): void {
		this.owners.set(signal, owner)
	}

	stopAt(signal: AbortSignal, expiresAt: number): void {
		this.stopDeadlines.set(signal, expiresAt)
	}

	graceDeadline(filePath: string): number {
		return this.deadlines.get(filePath) ?? 0
	}

	recover(files: string[], startedAt = Date.now()): void {
		for (const filePath of files) {
			this.deadlines.set(filePath, Math.max(this.deadlines.get(filePath) ?? 0, startedAt + LATE_WRITE_GRACE_MS))
		}
	}

	needsReconciliation(filePath: string): boolean {
		return this.deadlines.has(filePath)
	}

	reconciled(filePath: string): void {
		this.deadlines.delete(filePath)
	}

	hasPending(signal: AbortSignal): boolean {
		return (this.issued.get(signal)?.size ?? 0) > 0
	}

	async settled(signal: AbortSignal): Promise<void> {
		while (this.hasPending(signal)) {
			await Promise.allSettled([...this.issued.get(signal)!].map((write) => write.pending))
		}
	}

	uncertainFiles(signal: AbortSignal): string[] {
		return [...(this.uncertainByAttempt.get(signal) ?? [])]
	}

	private markUncertain(signal: AbortSignal, files: string[], startedAt = Date.now()): void {
		let uncertain = this.uncertainByAttempt.get(signal)
		if (!uncertain) {
			uncertain = new Set()
			this.uncertainByAttempt.set(signal, uncertain)
		}
		for (const filePath of files) uncertain.add(filePath)
		this.recover(files, startedAt)
	}

	abandon(signal: AbortSignal, startedAt = Date.now()): void {
		for (const write of this.issued.get(signal) ?? []) {
			if (write.abandoned) continue
			write.abandoned = true
			this.markUncertain(signal, write.files, startedAt)
		}
	}

	async waitForPriorWrites(filePath: string, signal: AbortSignal): Promise<boolean> {
		const currentOwner = this.owners.get(signal) ?? signal
		let waited = false
		while (true) {
			throwIfAborted(signal)
			const pending: Promise<unknown>[] = []
			let remaining = Infinity
			for (const [owner, writes] of this.issued) {
				if (owner === currentOwner || !owner.aborted) continue
				const relevant = [...writes].filter((write) => !write.abandoned && write.files.includes(filePath))
				if (relevant.length === 0) continue
				const stopDeadline = this.stopDeadlines.get(owner)
				if (stopDeadline === undefined) throw new Error("Missing indexing stop deadline")
				if (stopDeadline <= Date.now()) {
					this.abandon(owner, stopDeadline)
					continue
				}
				remaining = Math.min(remaining, stopDeadline - Date.now())
				pending.push(...relevant.map((write) => write.pending))
			}
			if (pending.length === 0) return waited
			waited = true
			await new Promise<void>((resolve, reject) => {
				const finish = (error?: Error) => {
					clearTimeout(timer)
					signal.removeEventListener("abort", onAbort)
					if (error) reject(error)
					else resolve()
				}
				const onAbort = () => finish(abortError())
				const timer = setTimeout(() => finish(), remaining)
				signal.addEventListener("abort", onAbort, { once: true })
				void Promise.allSettled(pending).then(() => finish())
				if (signal.aborted) onAbort()
			})
		}
	}

	async waitForGrace(filePath: string, signal: AbortSignal): Promise<void> {
		while (true) {
			throwIfAborted(signal)
			const remaining = (this.deadlines.get(filePath) ?? 0) - Date.now()
			if (remaining <= 0) return
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer)
					signal.removeEventListener("abort", onAbort)
					reject(abortError())
				}
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort)
					resolve()
				}, remaining)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) onAbort()
			})
		}
	}

	async run<Result>(
		signal: AbortSignal,
		write: () => Result | Promise<Result>,
		files: string[] = [],
	): Promise<Result> {
		throwIfAborted(signal)
		const owner = this.owners.get(signal) ?? signal
		if (!this.observedOwners.has(owner)) {
			this.observedOwners.add(owner)
			const onAbort = () => {
				if (!this.stopDeadlines.has(owner)) this.stopAt(owner, Date.now() + INDEX_STOP_LIMIT_MS)
			}
			if (owner.aborted) onAbort()
			else owner.addEventListener("abort", onAbort, { once: true })
		}
		let writes = this.issued.get(owner)
		if (!writes) {
			writes = new Set()
			this.issued.set(owner, writes)
		}
		let issued = false
		let succeeded = false
		const pending = Promise.resolve().then(() => {
			throwIfAborted(signal)
			issued = true
			return write()
		})
		const record = { pending, files: [...files] }
		writes.add(record)
		try {
			const result = await pending
			succeeded = true
			throwIfAborted(signal)
			return result
		} catch (error) {
			if (issued && !succeeded) this.markUncertain(owner, files)
			throw error
		} finally {
			writes.delete(record)
			if (writes.size === 0) this.issued.delete(owner)
		}
	}
}
