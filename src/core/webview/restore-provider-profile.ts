// Restore-profile decision for task restore (issue #970).
//
// When a stopped task is restored, its HistoryItem.apiConfigName pins the provider
// profile the task last ran under. If the user switched to a different profile
// while the task was stopped, blindly re-activating that pin reverts the user's
// choice: the restored task and the task header keep the old provider's context
// window, and the usage bar can exceed 100%.
//
// Invariants (first version written before the fix; see
// docs/architecture/tla/RestoreProfileDecision.tla):
// - FollowActive: with an existing pin and a resolvable active profile that
//   differs from it, restore must not reactivate the pinned profile.
// - PinNamesEffect: a pin refresh must name exactly the active profile, and a
//   decision that reactivates must never also refresh.
// - LegacyFallback: with no resolvable active profile, an existing pinned
//   profile is reactivated exactly as before the change.

/** A profile to re-activate, or undefined to leave the active configuration untouched. */
export interface RestoreProfileDecision {
	/** Profile to re-activate before constructing the restored task; undefined leaves the current configuration in place. */
	reactivateProfileName: string | undefined
	/** Replacement pin for the history item; undefined keeps the stored pin unchanged. */
	refreshedApiConfigName: string | undefined
}

export interface RestoreProfileInput {
	/** The pin recorded on the history item at last save; undefined when absent. */
	pinnedApiConfigName: string | undefined
	/** The profile active at restore time (currentApiConfigName); undefined when none resolves. */
	activeProfileName: string | undefined
	/** Whether the pinned profile still exists in the profile list. */
	pinnedProfileExists: boolean
}

/**
 * Decide how a task restore treats the profile pin stored on its history item.
 *
 * Rules:
 * - No pin: nothing to do; the active configuration stays untouched.
 * - Pin exists and no active profile resolves: legacy fallback re-activates the pin.
 * - Pin exists and equals the active profile: re-activate it (idempotent re-apply
 *   of the saved profile settings, unchanged behavior for restores without a switch).
 * - Pin exists and differs from the active profile: keep the user's active profile
 *   and refresh the stale pin to it.
 * - Pin no longer exists: keep the active configuration; refresh the pin to the
 *   active profile when one resolves.
 */
export function resolveRestoreProfileActivation(input: RestoreProfileInput): RestoreProfileDecision {
	const { pinnedApiConfigName, activeProfileName, pinnedProfileExists } = input

	if (!pinnedApiConfigName) {
		return { reactivateProfileName: undefined, refreshedApiConfigName: undefined }
	}

	if (!pinnedProfileExists) {
		// The pinned profile is gone; the active configuration (if any) is what runs.
		return { reactivateProfileName: undefined, refreshedApiConfigName: activeProfileName }
	}

	if (!activeProfileName || activeProfileName === pinnedApiConfigName) {
		// No switch happened since the save: re-apply the saved profile settings as before.
		return { reactivateProfileName: pinnedApiConfigName, refreshedApiConfigName: undefined }
	}

	// The user switched profiles while the task was stopped; their choice wins.
	return { reactivateProfileName: undefined, refreshedApiConfigName: activeProfileName }
}
