import { describe, expect, it } from "vitest"

import {
	createProviderHandoffPlan,
	decideProviderHandoffProfile,
	getProviderHandoffActivationOptions,
	PRODUCTION_PROVIDER_HANDOFF_POLICY,
	publishProviderHandoffState,
	shouldPublishProviderHandoffState,
	type ProviderHandoffPolicy,
} from "../providerHandoff"

describe("provider handoff contract", () => {
	it("creates a no-target, non-publishing production plan", () => {
		expect(createProviderHandoffPlan("child-mode")).toEqual({
			requestedMode: "child-mode",
			policy: {
				targetTask: null,
				mutateExposedTask: false,
				publishWhilePending: false,
				applyProviderSettingsToContext: true,
			},
		})
	})

	it("selects the current profile while workspace profile locking is enabled", () => {
		expect(
			decideProviderHandoffProfile({
				locked: true,
				currentProfile: { name: "current", id: "current-id" },
				savedProfile: { name: "saved", id: "saved-id" },
			}),
		).toEqual({ source: "locked-current", profile: { name: "current", id: "current-id" } })
		expect(decideProviderHandoffProfile({ locked: true })).toEqual({
			source: "locked-current",
			profile: undefined,
		})
	})

	it("selects a saved mode profile when profile locking is disabled", () => {
		expect(
			decideProviderHandoffProfile({
				locked: false,
				currentProfile: { name: "current", id: "current-id" },
				savedProfile: { name: "saved", id: "saved-id" },
			}),
		).toEqual({ source: "saved", profile: { name: "saved", id: "saved-id" } })
	})

	it("inherits and persists the current profile for an unsaved mode", () => {
		expect(
			decideProviderHandoffProfile({
				locked: false,
				currentProfile: { name: "current", id: "current-id" },
			}),
		).toEqual({
			source: "unsaved-current",
			profile: { name: "current", id: "current-id" },
			persistModeProfileId: "current-id",
		})
		expect(decideProviderHandoffProfile({ locked: false })).toEqual({
			source: "unsaved-current",
			profile: undefined,
			persistModeProfileId: undefined,
		})
	})

	it("projects production and injected policies into activation options", () => {
		expect(getProviderHandoffActivationOptions(PRODUCTION_PROVIDER_HANDOFF_POLICY)).toEqual({
			skipCurrentTaskRebuild: true,
			applyProviderSettingsToContext: true,
			suppressStatePost: true,
		})

		const unsafePolicy: ProviderHandoffPolicy = {
			targetTask: null,
			mutateExposedTask: true,
			publishWhilePending: true,
			applyProviderSettingsToContext: false,
		}
		expect(getProviderHandoffActivationOptions(unsafePolicy)).toEqual({
			skipCurrentTaskRebuild: false,
			applyProviderSettingsToContext: false,
			suppressStatePost: false,
		})
	})

	it("publishes only when a target exists and the handoff policy permits it", () => {
		expect(shouldPublishProviderHandoffState(true)).toBe(true)
		expect(shouldPublishProviderHandoffState(false)).toBe(false)
		expect(shouldPublishProviderHandoffState(true, PRODUCTION_PROVIDER_HANDOFF_POLICY)).toBe(false)
		expect(
			shouldPublishProviderHandoffState(true, {
				targetTask: null,
				mutateExposedTask: true,
				publishWhilePending: true,
				applyProviderSettingsToContext: false,
			}),
		).toBe(true)
	})

	it("invokes publication only when the production decision allows it", async () => {
		const publish = vi.fn().mockResolvedValue(undefined)
		await publishProviderHandoffState(false, undefined, publish)
		await publishProviderHandoffState(true, PRODUCTION_PROVIDER_HANDOFF_POLICY, publish)
		expect(publish).not.toHaveBeenCalled()

		await publishProviderHandoffState(true, undefined, publish)
		expect(publish).toHaveBeenCalledOnce()
	})
})
