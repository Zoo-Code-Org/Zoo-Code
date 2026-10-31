import type { ClineMessage, UsageByModelEntry } from "@roo-code/types"

/**
 * Totals per provider+model from a task's `api_req_started` messages.
 *
 * Provider and model are read from the message itself (recorded when the
 * request was made), never from the *current* profile, so a task that ran on
 * Copilot keeps saying so after the user switches providers. A task can span
 * several models, hence a list.
 *
 * Messages written before this was recorded carry no provider/model; their
 * tokens are grouped under an entry with both fields undefined ("not
 * recorded") rather than guessed.
 */
export function summarizeUsageByModel(messages: ClineMessage[]): UsageByModelEntry[] {
	const byKey = new Map<string, UsageByModelEntry>()

	for (const message of messages) {
		if (message.type !== "say" || message.say !== "api_req_started" || !message.text) continue

		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(message.text)
		} catch {
			continue
		}

		// Valid JSON that is not an object ("null", a number, a string) has no fields to read.
		if (typeof parsed !== "object" || parsed === null) continue

		// A placeholder (request not finished) has no token counts yet.
		if (typeof parsed.tokensIn !== "number" && typeof parsed.tokensOut !== "number") continue

		const apiProvider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : undefined
		const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined
		const key = `${apiProvider ?? ""}\u0000${modelId ?? ""}`

		let entry = byKey.get(key)
		if (!entry) {
			entry = { apiProvider, modelId, requests: 0, tokensIn: 0, tokensOut: 0, cost: 0 }
			byKey.set(key, entry)
		}

		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
		entry.requests += 1
		entry.tokensIn += num(parsed.tokensIn)
		entry.tokensOut += num(parsed.tokensOut)
		entry.cost += num(parsed.cost)
		if (typeof parsed.cacheReads === "number") entry.cacheReads = (entry.cacheReads ?? 0) + parsed.cacheReads
		if (typeof parsed.cacheWrites === "number") entry.cacheWrites = (entry.cacheWrites ?? 0) + parsed.cacheWrites
	}

	return [...byKey.values()]
}

/**
 * The model to record for a finished request. The first write (before the request starts) only knows the
 * model the profile names; a profile that names none leaves it empty. By the time the request is done the
 * model that actually served it is known, so use that rather than leave the usage unattributed. A model
 * recorded earlier is never overwritten.
 */
export function resolveRecordedModelId(recorded: unknown, served: string | undefined): string | undefined {
	return typeof recorded === "string" && recorded.length > 0 ? recorded : served
}

/**
 * Binds a request's placeholder `api_req_started` to the handler that serves it. The placeholder is written before
 * the rate-limit wait and the environment details, and a profile switch in that window replaces the handler, so the
 * provider and model written then can differ from the handler whose tokens and cost are recorded at the end. Called
 * once the serving handler is known. The configured model is kept when the profile names one; otherwise the model the
 * handler reports is recorded.
 */
export function bindRequestToHandler(
	text: string | undefined,
	handler: {
		apiProvider: string | undefined
		configuredModelId: string | undefined
		servedModelId: string | undefined
	},
): string {
	let existing: Record<string, unknown> = {}
	try {
		existing = JSON.parse(text || "{}")
	} catch {
		// An unreadable placeholder is replaced, not kept.
	}

	return JSON.stringify({
		...existing,
		apiProvider: handler.apiProvider,
		modelId: resolveRecordedModelId(handler.configuredModelId, handler.servedModelId),
	})
}
