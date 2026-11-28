import { OutputTokenLimitError } from "../providers/utils/output-token-limit-error"
import { StreamStopError } from "../providers/utils/stream-stop-error"

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** Rejects terminal failures before output or usage can be reported as a successful response. */
export function assertResponsesApiSuccess(value: unknown, eventStatus?: string): void {
	const response = asRecord(value)
	const status = eventStatus ?? response.status
	if (status !== "failed" && status !== "incomplete" && status !== "cancelled") return
	const details = asRecord(response.incomplete_details)
	if (status === "incomplete") {
		if (details.reason === "max_output_tokens") throw new OutputTokenLimitError()
		// An incomplete response other than the output limit is a provider stop,
		// for example content_filter (#2769). The same request can stop again, so
		// it must ask the user instead of riding the generic retry path.
		throw new StreamStopError(typeof details.reason === "string" ? details.reason : "unknown")
	}
	const error = asRecord(response.error)
	const message =
		typeof error.message === "string"
			? error.message
			: typeof response.message === "string"
				? response.message
				: typeof details.reason === "string"
					? details.reason
					: "No further details were provided"
	throw Object.assign(new Error(`Responses API response ${status}: ${message}`), {
		...(typeof error.code === "string"
			? { code: error.code }
			: typeof response.code === "string"
				? { code: response.code }
				: {}),
		errorDetails: response.error ?? response.incomplete_details,
	})
}
