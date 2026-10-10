import { CodexWebSocketContinuationRepository } from "../repositories/CodexWebSocketContinuationRepository"
import type { PreparedCodexRequest } from "../models/PreparedCodexRequest"
import type { CodexWebSocketResponseStateHolder } from "../state-holders/CodexWebSocketResponseStateHolder"
import type { CodexResponseEvent } from "../models/protocol"
import { asJsonObject, responseError } from "../utils/protocol"

/** Tracks response completion and the one safe cache-miss recovery, independently of socket IO. */
export class CodexWebSocketResponseManager {
	constructor(
		private readonly continuation: CodexWebSocketContinuationRepository,
		private readonly stateHolder: CodexWebSocketResponseStateHolder,
	) {}

	init(body: unknown): void {
		if (this.stateHolder.state.status !== "uninitialized") {
			throw new Error("Codex WebSocket response manager is already initialized")
		}
		this.stateHolder.initialize(this.continuation.prepare(body))
	}

	get preparedRequest(): PreparedCodexRequest {
		return this.stateHolder.preparedRequest
	}

	get completed(): boolean {
		return this.stateHolder.state.status === "completed"
	}

	accept(event: CodexResponseEvent): "emit" | "retry" {
		this.stateHolder.assertAcceptingEvents()
		switch (event.type) {
			case "error":
				return this.handleError(event)
			case "response.failed":
			case "response.incomplete":
				throw responseError(event)
			case "response.output_item.done":
				this.stateHolder.appendOutputItem(event.item)
				break
			case "response.completed":
			case "response.done":
				this.completeResponse(event.response)
				break
			default:
				this.stateHolder.startStreaming()
		}
		return "emit"
	}

	private completeResponse(response: unknown): void {
		const prepared = this.preparedRequest
		this.continuation.record(prepared, asJsonObject(response), [...this.stateHolder.streamedOutput])
		this.stateHolder.complete()
	}

	private handleError(event: CodexResponseEvent): "retry" {
		const error = asJsonObject(event.error)
		const canRecover = error.code === "previous_response_not_found" && this.stateHolder.canRecoverCacheMiss
		if (!canRecover) throw responseError(event)
		this.stateHolder.beginRecovery()
		this.continuation.reset()
		return "retry"
	}
}
