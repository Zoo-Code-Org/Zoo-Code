import type { Disposable, Event } from "vscode"
import { PACER_MAX_BACKOFF_MS } from "./constants"
import { classifyIndexingError, EmbeddingError } from "./shared/indexing-errors"

const MAX_TIMEOUT_MS = 2 ** 31 - 1

export interface ProviderWait {
	service: string
	resumeAt?: number
	waitingFiles: string[]
}

type Waiter = {
	path?: string
	signal?: AbortSignal
	resolve: () => void
	reject: (error: unknown) => void
	onAbort: () => void
}

function serviceLabel(scope: string): string {
	const prefix = scope.split(":", 1)[0]
	return /^[a-z][a-z0-9-]{0,63}$/i.test(prefix) ? prefix : "provider"
}

// In-memory equality ids: hashing the API key would be flagged as weak password hashing and adds nothing here.
const scopeIds = new Map<string, number>()

export function makeRateLimitScope(provider: string, baseUrl?: string, apiKey?: string, extra?: string): string {
	let normalizedUrl = ""
	if (baseUrl) {
		const parsedUrl = new URL(baseUrl)
		parsedUrl.username = ""
		parsedUrl.password = ""
		parsedUrl.hash = ""
		normalizedUrl = parsedUrl.toString().replace(/\/+$/, "")
	}
	const key = JSON.stringify([provider, normalizedUrl, apiKey ?? "", extra ?? ""])
	let id = scopeIds.get(key)
	if (id === undefined) {
		id = scopeIds.size + 1
		scopeIds.set(key, id)
	}
	return `${serviceLabel(provider)}:${id}`
}

/** Pause gate shared by every request on one service allowance. */
export class ProviderPacer {
	readonly service: string
	private pausedUntil = 0
	private consecutiveRateLimits = 0
	private timer?: ReturnType<typeof setTimeout>
	private readonly waiters = new Set<Waiter>()
	private readonly changes = new Set<() => void>()

	constructor(scope: string) {
		this.service = serviceLabel(scope)
	}

	readonly onDidChange: Event<void> = (listener, thisArgument, disposables) => {
		const callback = () => listener.call(thisArgument, undefined)
		this.changes.add(callback)
		const subscription: Disposable = { dispose: () => void this.changes.delete(callback) }
		disposables?.push(subscription)
		return subscription
	}

	get resumeAt(): number | undefined {
		return this.pausedUntil > Date.now() ? this.pausedUntil : undefined
	}

	get waitingPaths(): string[] {
		return [...new Set([...this.waiters].flatMap((waiter) => (waiter.path === undefined ? [] : [waiter.path])))]
	}

	get hasWaitingRequests(): boolean {
		return this.waiters.size > 0
	}

	async run<T>(path: string | undefined, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
		while (true) {
			if (Date.now() < this.pausedUntil) await this.wait(path, signal)
			signal?.throwIfAborted()
			try {
				const result = await request()
				this.consecutiveRateLimits = 0
				return result
			} catch (error) {
				if (classifyIndexingError(error, signal) !== "rate-limit") throw error
				this.pause(error)
			}
		}
	}

	private pause(error: unknown): void {
		const now = Date.now()
		// Concurrent 429s from requests sent before the pause belong to the same episode.
		if (now >= this.pausedUntil) this.consecutiveRateLimits++
		const requested = new EmbeddingError("Provider rate limited", error).retryAfterMs
		const delay =
			typeof requested === "number" && requested > 0 && Number.isFinite(new Date(now + requested).getTime())
				? requested
				: Math.min(PACER_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(30, this.consecutiveRateLimits - 1))
		this.pausedUntil = Math.max(this.pausedUntil, now + delay)
		this.schedule()
		this.changed()
	}

	private wait(path: string | undefined, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason)
				return
			}
			const waiter: Waiter = {
				path,
				signal,
				resolve,
				reject,
				onAbort: () => {
					this.waiters.delete(waiter)
					reject(signal?.reason)
					this.changed()
				},
			}
			this.waiters.add(waiter)
			signal?.addEventListener("abort", waiter.onAbort, { once: true })
			this.schedule()
			this.changed()
		})
	}

	private schedule(): void {
		if (this.timer !== undefined) clearTimeout(this.timer)
		const remaining = this.pausedUntil - Date.now()
		if (remaining > 0) {
			// setTimeout clamps delays above 2^31-1 ms to 1 ms, so long waits run in chunks.
			this.timer = setTimeout(() => this.schedule(), Math.min(MAX_TIMEOUT_MS, Math.ceil(remaining)))
			return
		}
		this.timer = undefined
		for (const waiter of this.waiters) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort)
			waiter.resolve()
		}
		this.waiters.clear()
		this.changed()
	}

	private changed(): void {
		for (const listener of this.changes) listener()
	}
}

export class ProviderPacerRegistry {
	private readonly pacers = new Map<string, ProviderPacer>()
	private readonly changes = new Set<() => void>()

	readonly onDidChange: Event<void> = (listener, thisArgument, disposables) => {
		const callback = () => listener.call(thisArgument, undefined)
		this.changes.add(callback)
		const subscription: Disposable = { dispose: () => void this.changes.delete(callback) }
		disposables?.push(subscription)
		return subscription
	}

	get(scope: string): ProviderPacer {
		let pacer = this.pacers.get(scope)
		if (!pacer) {
			pacer = new ProviderPacer(scope)
			pacer.onDidChange(() => {
				for (const listener of this.changes) listener()
			})
			this.pacers.set(scope, pacer)
		}
		return pacer
	}

	providerWaits(): ProviderWait[] {
		return [...this.pacers.values()].flatMap((pacer) => {
			const resumeAt = pacer.resumeAt
			return resumeAt === undefined
				? []
				: [{ service: pacer.service, resumeAt, waitingFiles: pacer.waitingPaths }]
		})
	}

	hasWaitingRequests(): boolean {
		return [...this.pacers.values()].some((pacer) => pacer.hasWaitingRequests && pacer.resumeAt !== undefined)
	}

	waitingPaths(): string[] {
		return [...new Set([...this.pacers.values()].flatMap((pacer) => pacer.waitingPaths))]
	}
}
