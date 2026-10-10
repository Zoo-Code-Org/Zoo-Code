/** Model discovery work owned by one webview. */
export class ModelRequestRegistry {
	private readonly requests = new Map<string, AbortController>()
	private disposed = false

	async run(id: string, fetch: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.disposed) return
		this.cancel(id)
		const controller = new AbortController()
		this.requests.set(id, controller)
		try {
			await fetch(controller.signal)
		} catch (error) {
			if (!controller.signal.aborted) throw error
		} finally {
			if (this.requests.get(id) === controller) this.requests.delete(id)
		}
	}

	cancel(id: string): void {
		this.requests.get(id)?.abort()
		this.requests.delete(id)
	}

	dispose(): void {
		this.disposed = true
		for (const id of this.requests.keys()) this.cancel(id)
	}
}
