export type McpOAuthFlowOutcome = "connected" | "cancelled" | "timed-out" | "removed" | "failed"

type McpOAuthFlowPhase = "waiting" | "authenticating" | "reconnecting" | "ended"

/** Owns one OAuth attempt, including its listeners and completion promise. */
export class McpOAuthFlow {
	private currentPhase: McpOAuthFlowPhase = "waiting"
	private waitingTimeout?: ReturnType<typeof setTimeout>
	get phase(): McpOAuthFlowPhase {
		return this.currentPhase
	}
	readonly promise: Promise<McpOAuthFlowOutcome>
	private readonly cancellation = new AbortController()
	get signal(): AbortSignal {
		return this.cancellation.signal
	}
	private resolve!: (outcome: McpOAuthFlowOutcome) => void
	private readonly cleanups: Array<() => void> = []

	constructor() {
		this.promise = new Promise((resolve) => {
			this.resolve = resolve
		})
	}

	addCleanup(cleanup: () => void): () => void {
		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			const index = this.cleanups.indexOf(dispose)
			if (index !== -1) this.cleanups.splice(index, 1)
			cleanup()
		}
		if (this.phase === "ended") dispose()
		else this.cleanups.push(dispose)
		return dispose
	}

	setWaitingTimeout(onTimeout: () => void, milliseconds: number): void {
		this.clearWaitingTimeout()
		if (this.phase !== "waiting") return
		this.waitingTimeout = setTimeout(() => {
			this.waitingTimeout = undefined
			if (this.phase === "waiting") onTimeout()
		}, milliseconds)
	}

	private clearWaitingTimeout(): void {
		clearTimeout(this.waitingTimeout)
		this.waitingTimeout = undefined
	}

	private transitionTo(phase: Exclude<McpOAuthFlowPhase, "waiting">): boolean {
		if (this.phase === "ended") return false
		this.clearWaitingTimeout()
		this.currentPhase = phase
		return true
	}

	beginReconnect(): void {
		this.transitionTo("reconnecting")
	}

	claim(): boolean {
		if (this.phase !== "waiting") return false
		return this.transitionTo("authenticating")
	}

	finish(outcome: McpOAuthFlowOutcome): void {
		if (!this.transitionTo("ended")) return
		if (outcome === "cancelled" || outcome === "timed-out" || outcome === "removed")
			this.cancellation.abort(outcome)
		for (const cleanup of this.cleanups.splice(0).reverse()) {
			try {
				cleanup()
			} catch (error) {
				console.error("[McpHub] OAuth flow cleanup failed:", error)
			}
		}
		this.resolve(outcome)
	}
}
