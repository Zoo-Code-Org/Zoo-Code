import { type ApiHandler } from "../../api/index"
import { ZooGatewayApiHandler } from "../../api/providers/zoo-gateway"

// 1-hour cache: key → { isSubscriber, expiresAt }
const subscriptionCache = new Map<string, { isSubscriber: boolean; expiresAt: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Resolves the API handler for LLM-assisted tool result compression.
 *
 * - Checks subscription status via Zoo Code API (cached 1hr per key)
 * - Subscribers → ZooGatewayApiHandler (routes through website → Vercel AI Gateway)
 * - Free users or missing key → null (Phase 1 hard truncation only)
 */
export async function resolveCompressionHandler(
	zooCodeApiKey: string | undefined,
	baseUrl: string = "https://zoocode.dev",
): Promise<ApiHandler | null> {
	if (!zooCodeApiKey?.trim()) {
		return null
	}

	const key = zooCodeApiKey.trim()

	// Check cache
	const cached = subscriptionCache.get(key)
	if (cached && cached.expiresAt > Date.now()) {
		return cached.isSubscriber ? new ZooGatewayApiHandler(baseUrl, key) : null
	}

	// Fetch subscription status
	try {
		const response = await fetch(`${baseUrl}/api/subscription/status`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(5_000),
		})

		if (!response.ok) {
			// 401 = invalid key, 403 = free plan — cache as non-subscriber
			subscriptionCache.set(key, { isSubscriber: false, expiresAt: Date.now() + CACHE_TTL_MS })
			return null
		}

		const status = await response.json()
		const isSubscriber = status.isSubscriber === true

		subscriptionCache.set(key, { isSubscriber, expiresAt: Date.now() + CACHE_TTL_MS })
		return isSubscriber ? new ZooGatewayApiHandler(baseUrl, key) : null
	} catch (err) {
		// Network error — fail open (don't block task startup)
		console.warn("[resolveCompressionHandler] Failed to check subscription status:", err)
		return null
	}
}

/**
 * Clear the subscription cache for a specific key (call when user saves new key in settings).
 */
export function clearSubscriptionCache(zooCodeApiKey?: string): void {
	if (zooCodeApiKey) {
		subscriptionCache.delete(zooCodeApiKey)
	} else {
		subscriptionCache.clear()
	}
}
