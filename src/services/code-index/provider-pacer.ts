import { createHash } from "node:crypto"
import type { Disposable, Event } from "vscode"
import {
	BATCH_PROCESSING_CONCURRENCY,
	PACER_INCREASE_AFTER,
	PACER_MAX_BACKOFF_MS,
	PACER_RESUME_SPACING_MS,
} from "./constants"
import { codeIndexLog } from "./code-index-log"
import { classifyIndexingError, EmbeddingError } from "./shared/indexing-errors"

const MAX_TIMEOUT_MS = 2 ** 31 - 1

export interface ProviderPacerState {
	pausedUntil?: number
	waitingPaths: string[]
	limit: number
	episodeSeq: number
	issueSeq: number
	consecutiveRateLimits: number
}

export interface ProviderWait {
	service: string
	resumeAt?: number
	waitingFiles: string[]
}

type Waiter = {
	path?: string
	signal?: AbortSignal
	resolve: (permit: Permit) => void
	reject: (error: unknown) => void
	onAbort: () => void
}

type Permit = { probeEpisode?: number }

function serviceLabel(scope: string): string {
	const prefix = scope.split(":", 1)[0]
	return /^[a-z][a-z0-9-]{0,63}$/i.test(prefix) ? prefix : "provider"
}

export function makeRateLimitScope(provider: string, baseUrl?: string, apiKey?: string, extra?: string): string {
	let normalizedUrl = ""
	if (baseUrl) {
		const parsedUrl = new URL(baseUrl)
		parsedUrl.username = ""
		parsedUrl.password = ""
		parsedUrl.hash = ""
		normalizedUrl = parsedUrl.toString().replace(/\/+$/, "")
	}
	const keyHash = apiKey ? createHash("sha256").update(apiKey).digest("hex") : ""
	// Hash the tuple as well: configured URLs can contain query-string credentials.
	const allowanceHash = createHash("sha256")
		.update(JSON.stringify([provider, normalizedUrl, keyHash, extra ?? ""]))
		.digest("hex")
	return `${serviceLabel(provider)}:${allowanceHash}`
}

export class ProviderPacer {
	readonly service: string
	private nextIssueSeq = 0
	private episodeSeq = 0
	private consecutiveRateLimits = 0
	private successes = 0
	private limit = BATCH_PROCESSING_CONCURRENCY
	private pausedUntil = 0
	private active = 0
	private needsProbe = false
	private probeEpisode?: number
	private probeGeneration = 0
	private stagedRemaining = 0
	private nextReleaseAt = 0
	private timer?: ReturnType<typeof setTimeout>
	private readonly waiters = new Set<Waiter>()
	private readonly changes = new Set<() => void>()

	constructor(scope: string) {
		this.service = serviceLabel(scope)
	}

	readonly onDidChange: Event<void> = (listener, thisArgument, disposables) => {
		const callback = () => listener.call(thisArgument, undefined)
		this.changes.add(callback)
		const subscription: Disposable = {
			dispose: () => {
				this.changes.delete(callback)
			},
		}
		disposables?.push(subscription)
		return subscription
	}

	state(): ProviderPacerState {
		return {
			pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : undefined,
			waitingPaths: [
				...new Set([...this.waiters].flatMap((waiter) => (waiter.path === undefined ? [] : [waiter.path]))),
			],
			limit: this.limit,
			episodeSeq: this.episodeSeq,
			issueSeq: this.nextIssueSeq,
			consecutiveRateLimits: this.consecutiveRateLimits,
		}
	}

	get hasWaitingRequests(): boolean {
		return this.waiters.size > 0
	}

	markIssued(): number {
		return this.nextIssueSeq++
	}

	reportRateLimit(error: unknown, issueSeq: number): void {
		const now = Date.now()
		const paused = now < this.pausedUntil
		const stale = issueSeq < this.episodeSeq
		const requestedDelay = new EmbeddingError("Provider rate limited", error).retryAfterMs
		const providerDelay =
			typeof requestedDelay === "number" && Number.isFinite(requestedDelay) && requestedDelay > 0
				? requestedDelay
				: undefined
		if (stale && providerDelay === undefined) return
		const newEpisode = !paused && !stale
		if (newEpisode) {
			this.episodeSeq = this.nextIssueSeq
			this.consecutiveRateLimits++
			this.limit = Math.max(1, Math.floor(this.limit / 2))
			this.successes = 0
		}
		const base = Math.min(
			PACER_MAX_BACKOFF_MS,
			1000 * 2 ** Math.min(30, Math.max(0, this.consecutiveRateLimits - 1)),
		)
		const delay = providerDelay ?? base / 2 + (Math.random() * base) / 2
		const extendedUntil = Math.max(this.pausedUntil, now + delay)
		if (!newEpisode && extendedUntil === this.pausedUntil) return
		this.pausedUntil = extendedUntil
		this.needsProbe = true
		this.probeGeneration++
		this.probeEpisode = undefined
		this.stagedRemaining = 0
		this.nextReleaseAt = 0
		codeIndexLog.info("Provider pacing wait", {
			service: this.service,
			delayMs: this.pausedUntil - now,
			source: providerDelay === undefined ? "backoff" : "provider",
			waitingCount: this.state().waitingPaths.length,
		})
		this.changed()
		this.pump()
	}

	async run<T>(path: string | undefined, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
		while (true) {
			const permit = await this.acquire(path, signal)
			let rateLimited = false
			const onAbort = () => this.finishProbe(permit)
			signal?.addEventListener("abort", onAbort, { once: true })
			try {
				signal?.throwIfAborted()
				// Another completion may pause the allowance before this granted permit is consumed.
				if (Date.now() < this.pausedUntil) continue
				const issueSeq = this.markIssued()
				try {
					const result = await request()
					if (!signal?.aborted && issueSeq >= this.episodeSeq) {
						this.consecutiveRateLimits = 0
						if (++this.successes >= PACER_INCREASE_AFTER) {
							this.successes = 0
							this.limit = Math.min(BATCH_PROCESSING_CONCURRENCY, this.limit + 1)
							this.changed()
						}
					}
					return result
				} catch (error) {
					if (issueSeq >= this.episodeSeq) this.successes = 0
					if (classifyIndexingError(error, signal) !== "rate-limit") throw error
					rateLimited = true
					this.reportRateLimit(error, issueSeq)
				}
			} finally {
				signal?.removeEventListener("abort", onAbort)
				this.active--
				if (!rateLimited) this.finishProbe(permit)
				this.pump()
			}
		}
	}

	private acquire(path: string | undefined, signal?: AbortSignal): Promise<Permit> {
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
					signal?.removeEventListener("abort", waiter.onAbort)
					reject(signal?.reason)
					this.changed()
					this.pump()
				},
			}
			this.waiters.add(waiter)
			signal?.addEventListener("abort", waiter.onAbort, { once: true })
			this.changed()
			this.pump()
		})
	}

	private finishProbe(permit: Permit): void {
		if (permit.probeEpisode === undefined || permit.probeEpisode !== this.probeEpisode) return
		this.probeEpisode = undefined
		this.stagedRemaining = this.limit - 1
		this.nextReleaseAt = Date.now() + this.resumeGap()
		this.pump()
	}

	private resumeGap(): number {
		return PACER_RESUME_SPACING_MS * (0.5 + Math.random())
	}

	private pump(): void {
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
		const now = Date.now()
		if (now < this.pausedUntil) {
			this.schedule(this.pausedUntil - now)
			return
		}
		if (this.pausedUntil !== 0) {
			this.pausedUntil = 0
			this.changed()
		}
		if (this.probeEpisode !== undefined || this.waiters.size === 0 || this.active >= this.limit) return
		if (now < this.nextReleaseAt) {
			this.schedule(this.nextReleaseAt - now)
			return
		}
		for (const waiter of this.waiters) {
			if (this.active >= this.limit) break
			this.waiters.delete(waiter)
			waiter.signal?.removeEventListener("abort", waiter.onAbort)
			const permit: Permit = {}
			if (this.needsProbe) {
				this.needsProbe = false
				this.probeEpisode = this.probeGeneration
				permit.probeEpisode = this.probeEpisode
			}
			this.active++
			waiter.resolve(permit)
			this.changed()
			if (permit.probeEpisode !== undefined) break
			if (this.stagedRemaining > 0) {
				this.stagedRemaining--
				this.nextReleaseAt = now + this.resumeGap()
				if (this.waiters.size > 0) this.schedule(this.nextReleaseAt - now)
				break
			}
		}
	}

	private schedule(delay: number): void {
		// Node clamps oversized timeouts to 1 ms; retain the full deadline and wait in chunks.
		this.timer = setTimeout(
			() => {
				this.timer = undefined
				this.pump()
			},
			Math.min(MAX_TIMEOUT_MS, Math.ceil(delay)),
		)
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
		const subscription: Disposable = {
			dispose: () => {
				this.changes.delete(callback)
			},
		}
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
			const state = pacer.state()
			return state.pausedUntil === undefined
				? []
				: [
						{
							service: pacer.service,
							resumeAt: state.pausedUntil,
							waitingFiles: state.waitingPaths,
						},
					]
		})
	}

	hasWaitingRequests(): boolean {
		return [...this.pacers.values()].some(
			(pacer) => pacer.hasWaitingRequests && pacer.state().pausedUntil !== undefined,
		)
	}

	waitingPaths(): string[] {
		return [...new Set([...this.pacers.values()].flatMap((pacer) => pacer.state().waitingPaths))]
	}
}
