import {
	getActiveCommitMessageProfile,
	normalizeCommitMessageProfiles,
	type CommitMessageAttributionSettings,
	type CommitMessageGitContextSettings,
	type CommitMessageProfilesSettings,
	type NormalizedCommitMessageProfile,
	type NormalizedCommitMessageProfiles,
} from "@roo-code/types"

import { ContextProxy } from "../../core/config/ContextProxy"

export interface CommitMessageProfileContextProxy {
	/** Reads persisted extension setting values by key. */
	getValue(key: any): unknown
}

/** Reads all commit-message profiles, normalized with legacy single-profile fallbacks. */
export function getCommitMessageProfileSettings(
	contextProxy: CommitMessageProfileContextProxy = ContextProxy.instance,
): NormalizedCommitMessageProfiles {
	return normalizeCommitMessageProfiles(
		readCommitMessageProfiles(contextProxy),
		readSingleProfileFallback(contextProxy),
	)
}

/** Reads the active commit-message profile for generator/provider runtime decisions. */
export function getActiveCommitMessageProfileSettings(
	contextProxy: CommitMessageProfileContextProxy = ContextProxy.instance,
): NormalizedCommitMessageProfile {
	return getActiveCommitMessageProfile(
		readCommitMessageProfiles(contextProxy),
		readSingleProfileFallback(contextProxy),
	)
}

/** Reads the raw persisted commit-message profiles object if present. */
function readCommitMessageProfiles(
	contextProxy: CommitMessageProfileContextProxy,
): CommitMessageProfilesSettings | undefined {
	return contextProxy.getValue("commitMessageProfiles") as CommitMessageProfilesSettings | undefined
}

/** Reads legacy single-profile settings used to synthesize the default profile. */
function readSingleProfileFallback(contextProxy: CommitMessageProfileContextProxy) {
	const customSupportPrompts = (contextProxy.getValue("customSupportPrompts") || {}) as Record<
		string,
		string | undefined
	>

	// Profile settings layer over the original single-profile keys so profiles can be removed cleanly.
	return {
		prompt: customSupportPrompts.COMMIT_MESSAGE,
		apiConfigId: contextProxy.getValue("commitMessageApiConfigId") as string | undefined,
		gitContext: contextProxy.getValue("commitMessageGitContext") as CommitMessageGitContextSettings | undefined,
		attribution: contextProxy.getValue("commitMessageAttribution") as CommitMessageAttributionSettings | undefined,
	}
}
