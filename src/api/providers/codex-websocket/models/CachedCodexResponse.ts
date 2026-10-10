import type { CodexWebSocketItemSnapshotModel } from "./CodexWebSocketItemSnapshotModel"

export interface CachedCodexResponse {
	id: string
	settings: string
	input: CodexWebSocketItemSnapshotModel[]
}
