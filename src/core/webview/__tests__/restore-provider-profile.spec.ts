// npx vitest run core/webview/__tests__/restore-provider-profile.spec.ts
//
// Decision-table tests for resolveRestoreProfileActivation, the pure decision at
// the heart of the issue #970 fix ("restore follows the active profile").
//
// Invariants (one per failure sentence):
// - FollowActive: with an existing pin and a resolvable active profile that
//   differs from it, the decision must not reactivate the pinned profile.
// - PinNamesEffect: a refresh must name exactly the active profile, and a
//   decision that reactivates must never also refresh.
// - LegacyFallback: with no resolvable active profile, an existing pinned
//   profile is reactivated exactly as before the fix.

import { describe, it, expect } from "vitest"

import { resolveRestoreProfileActivation } from "../restore-provider-profile"

describe("resolveRestoreProfileActivation", () => {
	it.each([
		{
			name: "no pin: nothing to reactivate and nothing to refresh",
			pinnedApiConfigName: undefined,
			activeProfileName: "provider-2",
			pinnedProfileExists: false,
			expected: { reactivateProfileName: undefined, refreshedApiConfigName: undefined },
		},
		{
			name: "existing pin with no resolvable active profile: legacy fallback reactivates the pin",
			pinnedApiConfigName: "provider-1",
			activeProfileName: undefined,
			pinnedProfileExists: true,
			expected: { reactivateProfileName: "provider-1", refreshedApiConfigName: undefined },
		},
		{
			name: "existing pin equal to the active profile: reactivation only, pin preserved",
			pinnedApiConfigName: "provider-1",
			activeProfileName: "provider-1",
			pinnedProfileExists: true,
			expected: { reactivateProfileName: "provider-1", refreshedApiConfigName: undefined },
		},
		{
			name: "existing pin that differs from the active profile: follow the active profile",
			pinnedApiConfigName: "provider-1",
			activeProfileName: "provider-2",
			pinnedProfileExists: true,
			expected: { reactivateProfileName: undefined, refreshedApiConfigName: "provider-2" },
		},
		{
			name: "deleted pin with no resolvable active profile: leave the configuration untouched",
			pinnedApiConfigName: "deleted-profile",
			activeProfileName: undefined,
			pinnedProfileExists: false,
			expected: { reactivateProfileName: undefined, refreshedApiConfigName: undefined },
		},
		{
			name: "deleted pin with a resolvable active profile: re-pin to the active profile",
			pinnedApiConfigName: "deleted-profile",
			activeProfileName: "provider-2",
			pinnedProfileExists: false,
			expected: { reactivateProfileName: undefined, refreshedApiConfigName: "provider-2" },
		},
	])("$name", ({ pinnedApiConfigName, activeProfileName, pinnedProfileExists, expected }) => {
		expect(
			resolveRestoreProfileActivation({
				pinnedApiConfigName,
				activeProfileName,
				pinnedProfileExists,
			}),
		).toStrictEqual(expected)
	})

	it("never returns a refresh together with a reactivation", () => {
		const decisions = [
			{ pinnedApiConfigName: undefined, activeProfileName: undefined, pinnedProfileExists: false },
			{ pinnedApiConfigName: "provider-1", activeProfileName: undefined, pinnedProfileExists: true },
			{ pinnedApiConfigName: "provider-1", activeProfileName: "provider-1", pinnedProfileExists: true },
			{ pinnedApiConfigName: "provider-1", activeProfileName: "provider-2", pinnedProfileExists: true },
			{ pinnedApiConfigName: "deleted-profile", activeProfileName: undefined, pinnedProfileExists: false },
			{ pinnedApiConfigName: "deleted-profile", activeProfileName: "provider-2", pinnedProfileExists: false },
		].map(resolveRestoreProfileActivation)

		for (const decision of decisions) {
			const combined =
				decision.reactivateProfileName !== undefined && decision.refreshedApiConfigName !== undefined
			expect(combined).toBe(false)
		}
	})
})
