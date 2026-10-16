import type { CachedCodexResponse } from "../../models/CachedCodexResponse"

/** Task-local, in-memory continuation cache. Stores snapshots only, never response content. */
export class CodexWebSocketResponseLocalDataSource {
	private response?: CachedCodexResponse

	read(): CachedCodexResponse | undefined {
		return this.response
	}

	write(response: CachedCodexResponse | undefined): void {
		this.response = response
	}

	clear(): void {
		this.response = undefined
	}
}
