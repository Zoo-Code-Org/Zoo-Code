import { createHash } from "node:crypto"
import stringify from "safe-stable-stringify"

import type { JsonObject, CodexResponseEvent } from "../models/protocol"

export function asJsonObject(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid Codex WebSocket payload")
	}
	return value as JsonObject
}

export function parseResponseEvent(data: string): CodexResponseEvent {
	const event = asJsonObject(JSON.parse(data))
	if (typeof event.type !== "string") throw new Error("Invalid Codex WebSocket event type")
	return event as CodexResponseEvent
}

export function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(stringify(value) ?? "null")
		.digest("hex")
}

export function responseError(event: CodexResponseEvent): Error {
	const response = event.response ? asJsonObject(event.response) : undefined
	const error = event.error ?? response?.error ?? response?.incomplete_details
	const details = error ? asJsonObject(error) : {}
	return new Error(
		`Codex WebSocket (${String(event.status ?? event.type)}): ${String(details.message ?? details.code ?? details.reason ?? "request failed")}`,
	)
}
