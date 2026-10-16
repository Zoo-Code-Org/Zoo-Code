import type { CodexWebSocketItemSnapshotModel } from "./CodexWebSocketItemSnapshotModel"
import type { JsonObject } from "./protocol"

export interface PreparedCodexRequest {
	request: JsonObject
	input: unknown[]
	snapshots: CodexWebSocketItemSnapshotModel[]
	settings: string
	previousResponseId?: string
	offset: number
	fullContextReason?: string
}
