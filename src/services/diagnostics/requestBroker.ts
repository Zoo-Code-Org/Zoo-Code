import { randomUUID } from "crypto"

import type { WebviewDiagnosticsSnapshot } from "@roo-code/types"

export class DiagnosticsRequestBroker {
	private readonly pending = new Map<
		string,
		{ resolve: (snapshot: WebviewDiagnosticsSnapshot | undefined) => void; timeout: ReturnType<typeof setTimeout> }
	>()

	request(
		send: (requestId: string) => Promise<void>,
		timeoutMs: number,
	): Promise<WebviewDiagnosticsSnapshot | undefined> {
		const requestId = randomUUID()
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId)
				resolve(undefined)
			}, timeoutMs)
			this.pending.set(requestId, { resolve, timeout })
			void send(requestId).catch(() => {
				clearTimeout(timeout)
				this.pending.delete(requestId)
				resolve(undefined)
			})
		})
	}

	resolve(requestId: string, snapshot: WebviewDiagnosticsSnapshot | undefined): boolean {
		const pending = this.pending.get(requestId)
		if (!pending) return false
		clearTimeout(pending.timeout)
		this.pending.delete(requestId)
		pending.resolve(snapshot)
		return true
	}

	dispose(): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout)
			pending.resolve(undefined)
		}
		this.pending.clear()
	}
}
