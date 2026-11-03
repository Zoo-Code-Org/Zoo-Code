import type { ModelInfo, PromptCacheTtl } from "@roo-code/types"
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources"

/**
 * Resolve the TTL a request may emit, gated by the provider-profile knob and the
 * model's catalog capability. Both gates fail closed: absent capability means
 * "5m only" (ADR-0006 I2), and capability is read from the resolved `ModelInfo`
 * rather than inferred from the model id.
 *
 * `"5m"` resolves to `undefined` on purpose. It is the vendor default, so emitting
 * it would add bytes without changing behavior; only `"1h"` may change the wire,
 * which keeps default parity (I3) checkable by a single grep.
 */
export function resolveCacheTtl(
	settings: { promptCacheTtl?: PromptCacheTtl } | undefined,
	info: Pick<ModelInfo, "promptCacheTtlSupport"> | undefined,
): PromptCacheTtl | undefined {
	if (settings?.promptCacheTtl !== "1h") {
		return undefined
	}

	return info?.promptCacheTtlSupport?.includes("1h") ? "1h" : undefined
}

/**
 * Build the `cache_control` object for one marker. Every marker in a request goes
 * through this function, which makes one uniform TTL per request (I4) structural
 * instead of a convention each call site has to remember.
 */
export function cacheControl(ttl: PromptCacheTtl | undefined): CacheControlEphemeral {
	return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" }
}
