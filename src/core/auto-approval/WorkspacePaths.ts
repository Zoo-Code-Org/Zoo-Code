import path from "path"

/** Windows UNC roots have exactly two leading separators and nonempty server/share names. */
export const WINDOWS_UNC_PREFIX = /^\/\/([^/]+)\/+([^/]+)/

/** A bare drive designator is drive-relative and cannot anchor an absolute path. */
export const WINDOWS_DRIVE_PREFIX = /^([a-zA-Z]):(?=\/)/

/** Share platform path handling and verified workspace-root equivalence within one match. */
export class WorkspacePaths {
	readonly isWindows: boolean
	readonly workspacePath: string
	readonly workspaceVolume: string
	readonly matcherVolume: string
	readonly canResolveRelativePaths: boolean

	private readonly root: string | undefined
	private readonly canonicalRoot: string | undefined

	constructor({ cwd, canonicalCwd, isWindows }: { cwd?: string; canonicalCwd?: string; isWindows: boolean }) {
		this.isWindows = isWindows
		this.workspacePath = this.normalizeSeparators(cwd ?? "")
		const unc = isWindows ? WINDOWS_UNC_PREFIX.exec(this.workspacePath) : null
		const drive = isWindows ? WINDOWS_DRIVE_PREFIX.exec(this.workspacePath) : null
		this.workspaceVolume = unc ? `/UNC/${unc[1]}/${unc[2]}` : drive ? `/${drive[1]}` : ""
		this.matcherVolume = this.toMatcherAbsolutePath("/", this.workspaceVolume).replace(/\/$/, "")
		this.canResolveRelativePaths = !!cwd && !this.isDriveRelativePath(this.workspacePath)
		this.root = this.normalizeAbsoluteRoot(cwd)
		this.canonicalRoot = this.normalizeAbsoluteRoot(canonicalCwd)
	}

	/** Off Windows, backslashes remain literal filename characters. */
	normalizeSeparators(value: string): string {
		return this.isWindows ? value.replace(/\\/g, "/") : value
	}

	/** Device/extended namespaces need different path semantics than ordinary drives and UNC shares. */
	isWindowsNamespacePath(value: string | undefined): boolean {
		return this.isWindows && /^\/\/[?.]\//.test(this.normalizeSeparators(value ?? ""))
	}

	/** Classify a path after normalizeSeparators has applied the platform's separator rules. */
	isAbsolutePath(value: string): boolean {
		return value.startsWith("/") || (this.isWindows && WINDOWS_DRIVE_PREFIX.test(value))
	}

	/** A slash-normalized drive-relative path depends on per-drive state, not the task workspace. */
	isDriveRelativePath(value: string): boolean {
		return this.isWindows && /^[a-zA-Z]:(?!\/)/.test(value)
	}

	/** Convert a slash-normalized absolute path into the matcher's platform namespace. */
	toMatcherAbsolutePath(absolutePath: string, workspaceVolume = this.workspaceVolume): string {
		if (!this.isWindows) return absolutePath

		// Keep UNC paths independent of the current drive and distinct from drive letters.
		const unc = WINDOWS_UNC_PREFIX.exec(absolutePath)
		if (unc) return `/UNC/${unc[1]}/${unc[2]}${absolutePath.slice(unc[0].length)}`

		const drive = WINDOWS_DRIVE_PREFIX.exec(absolutePath)
		// Rooted paths belong to the workspace drive/share. Without a known volume,
		// keep them separate so /UNC/... cannot impersonate a share.
		return drive
			? `/${drive[1]}${absolutePath.slice(drive[0].length)}`
			: `${workspaceVolume || "/ROOT"}${absolutePath.replace(/^\/+/, "/")}`
	}

	/** Keep both verified root spellings, never resolve an individual file alias. */
	equivalentPaths(value: string): string[] {
		if (this.root === undefined || this.canonicalRoot === undefined) return [value]

		const canonical = this.replaceWorkspaceRootPrefix(value, this.root, this.canonicalRoot)
		const equivalent =
			canonical !== value ? canonical : this.replaceWorkspaceRootPrefix(value, this.canonicalRoot, this.root)
		return equivalent === value ? [value] : [value, equivalent]
	}

	private normalizeAbsoluteRoot(root: string | undefined): string | undefined {
		if (!this.isWindows) {
			if (!root?.startsWith("/")) return undefined
			return path.posix.resolve(this.toMatcherAbsolutePath(root)).replace(/\/$/, "")
		}

		const normalized = this.normalizeSeparators(root ?? "")
		const drive = WINDOWS_DRIVE_PREFIX.exec(normalized)
		if (!normalized.startsWith("/") && !drive) return undefined

		// Resolve parents while drives and UNC shares are still filesystem roots.
		// The root's own namespace must not inherit the workspace volume.
		const absolutePath = this.normalizeSeparators(path.win32.normalize(normalized))
		return this.toMatcherAbsolutePath(absolutePath, "").replace(/\/$/, "")
	}

	private pathsEqual(left: string, right: string): boolean {
		if (!this.isWindows) return left === right

		// Match ignore's case rules without expanding Unicode or corrupting prefix offsets.
		if (left.length !== right.length) return false
		const literalRight = right.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		return new RegExp(`^${literalRight}$`, "i").test(left)
	}

	private replaceWorkspaceRootPrefix(value: string, root: string, canonicalRoot: string): string {
		const hasRootBoundary = value.length === root.length || value[root.length] === "/"
		return hasRootBoundary && this.pathsEqual(value.slice(0, root.length), root)
			? `${canonicalRoot}${value.slice(root.length)}`
			: value
	}
}
