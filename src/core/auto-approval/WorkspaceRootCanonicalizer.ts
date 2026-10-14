import type { WorkspaceRootStrategy } from "./strategies/WorkspaceRootStrategy"

/** Translate only a verified workspace-root spelling, never a file symlink. */
export class WorkspaceRootCanonicalizer {
	private constructor(
		private readonly root: string | undefined,
		private readonly canonicalRoot: string | undefined,
		private readonly strategy: WorkspaceRootStrategy,
	) {}

	static forStrategy(
		cwd: string | undefined,
		canonicalCwd: string | undefined,
		strategy: WorkspaceRootStrategy,
	): WorkspaceRootCanonicalizer {
		const root = strategy.normalizeAbsoluteRoot(cwd)
		const canonicalRoot = strategy.normalizeAbsoluteRoot(canonicalCwd)
		return new WorkspaceRootCanonicalizer(root, canonicalRoot, strategy)
	}

	canonicalize(value: string): string {
		if (this.root === undefined || this.canonicalRoot === undefined) return value

		return this.replaceWorkspaceRootPrefix(value, this.root, this.canonicalRoot)
	}

	/** Keep both verified spellings so globs spanning the root retain their meaning. */
	equivalentPaths(value: string): string[] {
		if (this.root === undefined || this.canonicalRoot === undefined) return [value]

		const canonical = this.canonicalize(value)
		const equivalent =
			canonical !== value ? canonical : this.replaceWorkspaceRootPrefix(value, this.canonicalRoot, this.root)
		return equivalent === value ? [value] : [value, equivalent]
	}

	private replaceWorkspaceRootPrefix(value: string, root: string, canonicalRoot: string): string {
		const comparableValue = this.strategy.comparisonKey(value)
		const comparableRoot = this.strategy.comparisonKey(root)
		return comparableValue === comparableRoot || comparableValue.startsWith(`${comparableRoot}/`)
			? `${canonicalRoot}${value.slice(root.length)}`
			: value
	}
}
