import type { JsonObject } from "./protocol"
import { fingerprint, asJsonObject } from "../utils/protocol"

/** Retain hashes only; diagnostic logs must never expose messages, arguments or encrypted reasoning. */
export class CodexWebSocketItemSnapshotModel {
	private constructor(
		readonly hash: string,
		readonly type: string,
		private readonly fields: Record<string, string>,
	) {}

	static create(value: unknown): CodexWebSocketItemSnapshotModel {
		const item = CodexWebSocketItemSnapshotModel.normalize(value)
		return new CodexWebSocketItemSnapshotModel(
			fingerprint(item),
			String(item.type ?? "message"),
			Object.fromEntries(Object.entries(item).map(([key, field]) => [key, fingerprint(field)])),
		)
	}

	changedFields(other: CodexWebSocketItemSnapshotModel): string[] {
		return Object.keys({ ...this.fields, ...other.fields }).filter((key) => this.fields[key] !== other.fields[key])
	}

	/** Compare wire history with Zoo's reconstructed history, ignoring response-only metadata. */
	private static normalize(value: unknown): JsonObject {
		const item = asJsonObject(value)
		switch (item.type) {
			case "message":
			case undefined:
				return {
					role: item.role,
					content: Array.isArray(item.content)
						? item.content.map((part: unknown) => {
								const content = asJsonObject(part)
								return content.type === "output_text"
									? { type: content.type, text: content.text }
									: content
							})
						: item.content,
				}
			case "function_call": {
				let args = item.arguments
				if (typeof args === "string") {
					try {
						args = JSON.parse(args)
					} catch {
						// Malformed arguments must still compare exactly.
					}
				}
				return { type: item.type, call_id: item.call_id, name: item.name, arguments: args }
			}
			case "reasoning":
				return { type: item.type, id: item.id, encrypted_content: item.encrypted_content }
			default:
				return item
		}
	}
}
