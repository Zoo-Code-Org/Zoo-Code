import {
	getCachedZooCodeToken,
	getZooCodeBaseUrl,
	getCachedSubscriptionStatus,
	checkSubscriptionStatus,
} from "./zoo-code-auth"
import { Package } from "../shared/package"

export type LlmTelemetryPayload = {
	taskId: string
	provider: string
	model: string
	mode?: string
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	totalCost?: number
	status?: "completed" | "cancelled"
}

/**
 * Send LLM telemetry to the Zoo Code observability backend.
 * This is a fire-and-forget operation that silently fails on error.
 * Only sends telemetry for authenticated users with active subscriptions.
 */
export async function sendLlmTelemetry(payload: LlmTelemetryPayload): Promise<void> {
	const token = getCachedZooCodeToken()
	if (!token) {
		return
	}

	// Check subscription status before sending (uses 5-minute cache)
	let status = getCachedSubscriptionStatus()
	if (status === "unknown") {
		status = await checkSubscriptionStatus().catch(() => "unknown" as const)
	}

	if (status !== "active") {
		return
	}

	const baseUrl = getZooCodeBaseUrl()

	const body = {
		...payload,
		status: payload.status ?? "completed",
		extensionVersion: Package.version,
		editor: "vscode",
	}

	void fetch(`${baseUrl}/api/observability/events`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	}).catch(() => {
		// Silently ignore errors - telemetry should never impact user experience
	})
}
