import type { CodexWebSocketResponseLocalDataSource } from "../data/local/CodexWebSocketResponseLocalDataSource"
import { CodexWebSocketItemSnapshotModel } from "../models/CodexWebSocketItemSnapshotModel"
import type { PreparedCodexRequest } from "../models/PreparedCodexRequest"
import type { JsonObject } from "../models/protocol"
import { fingerprint, asJsonObject } from "../utils/protocol"

/** Compares the server output with the history Zoo can reconstruct, retaining only hashes. */
export class CodexWebSocketContinuationRepository {
	constructor(private readonly store: CodexWebSocketResponseLocalDataSource) {}

	reset(): void {
		this.store.clear()
	}

	prepare(body: unknown): PreparedCodexRequest {
		const request = asJsonObject(body)
		if (!Array.isArray(request.input)) throw new Error("Codex WebSocket input must be an array")
		const { input: _input, ...settings } = request
		const settingsKey = fingerprint(settings)
		const snapshots = request.input.map((item) => CodexWebSocketItemSnapshotModel.create(item))
		const cached = this.store.read()
		return {
			request,
			input: request.input,
			snapshots,
			settings: settingsKey,
			previousResponseId: cached?.id,
			offset: cached?.input.length ?? 0,
			fullContextReason: this.getFullContextReason(settingsKey, snapshots),
		}
	}

	record(prepared: PreparedCodexRequest, response: JsonObject, streamedOutput: unknown[]): void {
		const output = Array.isArray(response.output) ? response.output : streamedOutput
		// Zoo replays only encrypted reasoning. Plain reasoning remains in the server cache,
		// but must not occupy a slot in the local history prefix.
		const replayable = output.filter((value) => {
			const item = asJsonObject(value)
			return item.type !== "reasoning" || Boolean(item.encrypted_content)
		})
		this.store.write(
			typeof response.id === "string"
				? {
						id: response.id,
						settings: prepared.settings,
						input: [
							...prepared.snapshots,
							...replayable.map((item) => CodexWebSocketItemSnapshotModel.create(item)),
						],
					}
				: undefined,
		)
	}

	private getFullContextReason(settings: string, input: CodexWebSocketItemSnapshotModel[]): string | undefined {
		const previous = this.store.read()
		if (!previous) return "no cached response"
		if (previous.settings !== settings) return "request settings changed"
		if (previous.input.length > input.length) return "history shortened"
		const index = previous.input.findIndex((item, index) => item.hash !== input[index].hash)
		if (index !== -1) {
			const before = previous.input[index]
			const after = input[index]
			const fields = before.changedFields(after)
			return `history changed at item ${index}: ${before.type} -> ${after.type}; fields: ${fields.join(", ")}`
		}
		return undefined
	}
}
