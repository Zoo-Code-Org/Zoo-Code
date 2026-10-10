import type WebSocket from "ws"

import type { CodexWebSocketConnectionManager } from "./codex-websocket/managers/CodexWebSocketConnectionManager"
import type { CodexWebSocketRequestManager } from "./codex-websocket/managers/CodexWebSocketRequestManager"
import type { CodexWebSocketResponseManager } from "./codex-websocket/managers/CodexWebSocketResponseManager"
import type { PreparedCodexRequest } from "./codex-websocket/models/PreparedCodexRequest"
import type { CodexResponseEvent, CodexWebSocketOptions } from "./codex-websocket/models/protocol"
import type { CodexWebSocketContinuationRepository } from "./codex-websocket/repositories/CodexWebSocketContinuationRepository"
import type { CodexWebSocketRequestScope } from "./codex-websocket/scopes/CodexWebSocketRequestScope"
import { asJsonObject, parseResponseEvent } from "./codex-websocket/utils/protocol"

export { CodexWebSocketUnavailableError } from "./codex-websocket/errors/CodexWebSocketUnavailableError"

/** Task-local Responses transport. Connection and history management are independent of provider event handling. */
export class CodexWebSocketTransport {
	private busy = false
	private requestScope?: CodexWebSocketRequestScope

	constructor(
		private readonly connection: CodexWebSocketConnectionManager,
		private readonly continuation: CodexWebSocketContinuationRepository,
		private readonly createRequestScope: (
			options: CodexWebSocketOptions,
			onAbort: () => void,
		) => CodexWebSocketRequestScope,
	) {}

	resetContinuation(): void {
		this.continuation.reset()
	}
	async dispose(): Promise<void> {
		const scope = this.requestScope
		this.requestScope = undefined
		this.connection.dispose()
		await scope?.dispose()
	}

	async *stream(body: unknown, options: CodexWebSocketOptions): AsyncGenerator<CodexResponseEvent> {
		if (this.busy) throw new Error("Concurrent requests on a Codex WebSocket are not supported")
		options.signal.throwIfAborted()
		const scope = this.createRequestScope(options, () => {
			void this.dispose()
		})
		let request: CodexWebSocketRequestManager | undefined
		let response: CodexWebSocketResponseManager | undefined
		this.busy = true
		this.requestScope = scope
		try {
			await scope.init(this.connection, this.continuation, body)
			request = scope.requestManager
			response = scope.responseManager
			const prepared = response.preparedRequest
			yield* this.readResponse(prepared, options.headers, request, response)
		} catch (error) {
			if (request?.signal.aborted) throw request.signal.reason
			options.signal.throwIfAborted()
			throw error
		} finally {
			await scope.dispose()
			if (this.requestScope === scope) this.requestScope = undefined
			this.busy = false
			if (!response?.completed || request?.signal.aborted) await this.dispose()
			else this.connection.release()
		}
	}

	private async *readResponse(
		prepared: PreparedCodexRequest,
		headers: Record<string, string>,
		request: CodexWebSocketRequestManager,
		response: CodexWebSocketResponseManager,
	): AsyncGenerator<CodexResponseEvent> {
		request.refreshTimeout()
		this.send(request.socket, prepared, headers, prepared.fullContextReason === undefined)
		for await (const [data] of request.events) {
			request.refreshTimeout()
			const event = parseResponseEvent(String(data))
			if (response.accept(event) === "retry") {
				this.send(request.socket, prepared, headers, false, "server cache miss")
				continue
			}
			if (response.completed) request.clearTimeout()
			yield event
			if (response.completed) return
		}
		throw new Error("Codex WebSocket closed before response completed; retry the request")
	}

	private send(
		socket: WebSocket,
		prepared: PreparedCodexRequest,
		headers: Record<string, string>,
		incremental: boolean,
		reason = prepared.fullContextReason,
	): void {
		const { request, input, previousResponseId, offset } = prepared
		const nextInput = incremental ? input.slice(offset) : input
		const clientMetadata = {
			...(request.client_metadata ? asJsonObject(request.client_metadata) : {}),
			...(headers["x-openai-internal-codex-responses-lite"] === "true"
				? { ws_request_header_x_openai_internal_codex_responses_lite: "true" }
				: {}),
		}
		console.info(
			`[Codex WebSocket] Sending ${incremental ? "incremental" : "full"} context` +
				` (${nextInput.length}/${input.length} input items${incremental ? "" : `; reason: ${reason}`})`,
		)
		socket.send(
			JSON.stringify({
				...request,
				type: "response.create",
				client_metadata: clientMetadata,
				previous_response_id: incremental ? previousResponseId : undefined,
				input: nextInput,
			}),
		)
	}
}
