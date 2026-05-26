import { defaultCommitMessageGitContextSettings, type CommitMessageGitContextSettings } from "@roo-code/types"

import { ContextProxy } from "../../core/config/ContextProxy"
import type { GitContextCollectorOptions } from "../git-context"

/** Reads and normalizes the persisted Git context settings for commit message generation. */
export function getCommitMessageGitContextSettings(): Required<CommitMessageGitContextSettings> {
	const rawSettings = ContextProxy.instance.getValue("commitMessageGitContext") as
		| CommitMessageGitContextSettings
		| undefined

	return normalizeCommitMessageGitContextSettings(rawSettings)
}

export function normalizeCommitMessageGitContextSettings(
	settings?: CommitMessageGitContextSettings,
): Required<CommitMessageGitContextSettings> {
	return {
		...defaultCommitMessageGitContextSettings,
		...settings,
		diffContextLines: clamp(
			settings?.diffContextLines,
			0,
			20,
			defaultCommitMessageGitContextSettings.diffContextLines,
		),
		recentCommitCount: clamp(
			settings?.recentCommitCount,
			1,
			20,
			defaultCommitMessageGitContextSettings.recentCommitCount,
		),
		recentCommitDiffCount: clamp(
			settings?.recentCommitDiffCount,
			1,
			5,
			defaultCommitMessageGitContextSettings.recentCommitDiffCount,
		),
	}
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

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback
	}

	return Math.min(Math.max(Math.trunc(value), min), max)
}
