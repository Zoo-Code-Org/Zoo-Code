/** Git status code emitted by porcelain and name-status commands. */
export type GitStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?" | "Unknown"

/** One repository file change selected for commit-message context. */
export interface GitChange {
	/** Absolute path to the changed file. */
	filePath: string
	/** Absolute previous path for rename or copy changes. */
	oldFilePath?: string
	/** Parsed Git status for the changed file. */
	status: GitStatus
	/** Whether this change came from the index instead of the working tree. */
	staged: boolean
}

/** Formatted Git context and non-fatal supplemental context warnings. */
export interface GitContextResult {
	/** Markdown context suitable for commit-message prompt input. */
	context: string
	/** Warnings from optional branch or recent-commit collection. */
	warnings: string[]
}

/** Combined change discovery and formatted context result. */
export interface GitContextCollection extends GitContextResult {
	/** File changes used to build the formatted context. */
	changes: GitChange[]
}

/** Base Git collection mode options. */
export interface GitContextOptions {
	/** Collect staged changes when true, otherwise collect unstaged changes. */
	staged: boolean
}

/** Diff formatting options for collected changes. */
export interface GitDiffContextOptions {
	/** Number of unchanged context lines around each hunk. */
	contextLines?: number
	/** Include diff-stat output before the full diff. */
	includeStats?: boolean
}

/** Recent-commit context options appended to formatted Git context. */
export interface GitRecentCommitContextOptions {
	/** Include recent commit context when true. */
	include?: boolean
	/** Number of recent commits to include. */
	count?: number
	/** Include commit body text when true. */
	includeBodies?: boolean
	/** Include recent commit stats when true. */
	includeStats?: boolean
	/** Include recent commit patches when true. */
	includeDiffs?: boolean
	/** Number of recent commit patches to include. */
	diffCount?: number
}

/** Full collector options for change discovery and context formatting. */
export interface GitContextCollectorOptions extends GitContextOptions {
	/** Receives coarse progress percentages during diff collection. */
	onProgress?: (percentage: number) => void
	/** Controls full-diff and stat formatting. */
	diff?: GitDiffContextOptions
	/** Include the current branch name when true. */
	includeBranch?: boolean
	/** Controls recent commit context inclusion. */
	recentCommits?: GitRecentCommitContextOptions
}
