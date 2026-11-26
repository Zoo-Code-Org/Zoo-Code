import { createHash } from "crypto"

/**
 * Fixed, non-secret application salt. The raw VS Code machine ID is a stable,
 * device-scoped identifier that may be considered personal data; combining it
 * with this salt under SHA-256 yields a pseudonymous distinct ID that is still
 * stable per device, so PostHog analytics and error grouping keep working while
 * the raw identifier never leaves the extension host.
 */
const DISTINCT_ID_SALT = "zoo-code-telemetry-distinct-id-v1"

export function hashDistinctId(machineId: string): string {
	return createHash("sha256").update(`${DISTINCT_ID_SALT}:${machineId}`).digest("hex")
}
