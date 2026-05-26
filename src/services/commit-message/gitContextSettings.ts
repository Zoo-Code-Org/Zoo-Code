import { type CommitMessageGitContextSettings } from "@roo-code/types"

import type { GitContextCollectorOptions } from "../git-context"
import { getActiveCommitMessageProfileSettings } from "./profileSettings"

/** Reads and normalizes the persisted Git context settings for commit message generation. */
export function getCommitMessageGitContextSettings(): Required<CommitMessageGitContextSettings> {
	return getActiveCommitMessageProfileSettings().gitContext
}

/** Converts commit-message settings into options consumed by the Git context collector. */
export function toGitContextCollectorOptions(
	staged: boolean,
	settings: Required<CommitMessageGitContextSettings>,
): GitContextCollectorOptions {
	return {
		staged,
		diff: {
			contextLines: settings.diffContextLines,
			includeStats: settings.includeDiffStats,
		},
		includeBranch: settings.includeCurrentBranch,
		recentCommits: {
			include: settings.includeRecentCommits,
			count: settings.recentCommitCount,
			includeBodies: settings.includeRecentCommitBodies,
			includeStats: settings.includeRecentCommitStats,
			includeDiffs: settings.includeRecentCommitDiffs,
			diffCount: settings.recentCommitDiffCount,
		},
	}
}
