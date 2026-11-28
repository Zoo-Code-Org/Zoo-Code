/**
 * Atomic markdown report writer for the sub-subtasks feature (design D6).
 *
 * Invariant: the host owns report persistence; children only return markdown
 * through attempt_completion and never touch the filesystem themselves. The
 * write below is atomic: content lands in a temp file in the same directory
 * and is committed with a single rename, so a reader never sees a partial
 * report and an interrupted write leaves the previous file intact. The temp
 * file is created exclusively (O_EXCL-style "wx"), so a pre-planted file at
 * the temp path fails the write instead of being overwritten or hijacked, and
 * the failure cleanup removes only a temp file this writer acquired.
 *
 * Containment is canonical, not lexical: `.zoocode` or any ancestor may be a
 * symlink (a junction on Windows), so the report directory is validated via
 * realpath before the mkdir and again after it, and a directory that resolves
 * outside `cwd` fails closed instead of publishing the report outside the
 * workspace.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { resolveReportPath } from "./naming"

export interface WriteSubtaskReportParams {
	cwd: string
	parentTaskId: string
	childTaskId: string
	label: string
	markdown: string
}

/** One written report; `path` is absolute. */
export interface SubtaskReport {
	path: string
	label: string
	taskId: string
	parentTaskId: string
}

/** Directory holding one parent's child reports. */
export function getSubtaskReportsDir(cwd: string, parentTaskId: string): string {
	return path.join(cwd, ".zoocode", "subtask-reports", parentTaskId)
}

/**
 * Temp path in the destination directory. The basename is deliberately short
 * and does not embed the destination name: a report name can approach the
 * 255-byte per-component limit on ext4 (60 UTF-8-heavy label characters plus a
 * 36-character child id), and a temp name built from it would exceed that
 * limit and fail the write. `pid` and the base-36 timestamp plus random suffix
 * keep concurrent writers in one directory apart.
 */
function createTempPath(targetPath: string): string {
	const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
	return path.join(path.dirname(targetPath), `.tmp-${unique}`)
}

/**
 * Realpath of the deepest existing ancestor of `target` (the path itself when
 * it exists), walking up on ENOENT. A dangling symlink fails closed: creation
 * flows (mkdir -p) would follow it and could escape the workspace. Returns
 * null on unexpected fs errors so the containment check fails closed. Mirrors
 * realPathOfExistingAncestor in src/utils/pathUtils.ts; it is duplicated here
 * because that helper is not exported and its module imports vscode, which
 * this vscode-free writer must not require.
 */
async function realPathOfExistingAncestor(target: string): Promise<string | null> {
	let current = target
	for (;;) {
		try {
			return await fs.realpath(current)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT") {
				return null
			}
			// ENOENT from realpath is ambiguous: the entry may not exist yet, or
			// it may be a dangling symlink whose target is missing. lstat does
			// not follow the final entry, so it distinguishes the two.
			try {
				const stat = await fs.lstat(current)
				if (stat.isSymbolicLink()) {
					return null
				}
			} catch (lstatError) {
				const lstatCode = (lstatError as NodeJS.ErrnoException).code
				if (lstatCode !== "ENOENT") {
					return null
				}
			}
			const parent = path.dirname(current)
			if (parent === current) {
				return null
			}
			current = parent
		}
	}
}

/**
 * Throws when `canonicalCandidate` is neither `canonicalRoot` nor one of its
 * descendants. `reportsDir` is the lexical path used for the error message.
 */
function assertContainedInWorkspace(canonicalRoot: string, canonicalCandidate: string, reportsDir: string): void {
	if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(canonicalRoot + path.sep)) {
		throw new Error(`subtask report directory escapes the workspace: ${reportsDir}`)
	}
}

/**
 * Atomically writes one child's markdown report to
 * `<cwd>/.zoocode/subtask-reports/<parentTaskId>/<safe-label>-<childTaskId>.md`.
 * Collision-free by construction (the child task id is globally unique) with a
 * numeric suffix if a sanitized collision still occurs; the resolved path is
 * guarded against escaping the reports directory, and the report directory
 * itself is guarded against escaping the workspace once symlinks are
 * resolved. Throws on any failure so the caller can mark the child failed
 * instead of silently losing the report.
 */
export async function writeSubtaskReport(params: WriteSubtaskReportParams): Promise<SubtaskReport> {
	const reportsDir = getSubtaskReportsDir(params.cwd, params.parentTaskId)

	// Fail closed before creating anything: if an existing ancestor of the
	// report directory (e.g. a symlinked .zoocode) resolves outside the
	// workspace, the mkdir below would publish the report outside the
	// workspace. realpath on the full path can fail because the leaf
	// directories do not exist yet, so the deepest existing ancestor is
	// checked instead.
	const canonicalCwd = await fs.realpath(params.cwd)
	const existingAncestor = await realPathOfExistingAncestor(reportsDir)
	if (!existingAncestor) {
		throw new Error(`subtask report directory escapes the workspace: ${reportsDir}`)
	}
	assertContainedInWorkspace(canonicalCwd, existingAncestor, reportsDir)

	await fs.mkdir(reportsDir, { recursive: true })

	// Re-validate through realpath after the mkdir: it catches a symlink
	// swapped in between the check above and the directory creation, and it
	// confirms the directory the temp file and rename will actually touch is
	// the canonical one inside the workspace. The lexical reportsDir still
	// drives naming and the returned path, so the public path shape is stable.
	const canonicalReportsDir = await fs.realpath(reportsDir)
	assertContainedInWorkspace(canonicalCwd, canonicalReportsDir, reportsDir)

	const targetPath = await resolveReportPath(reportsDir, params.label, params.childTaskId)
	const tempPath = createTempPath(targetPath)

	let tempAcquired = false
	try {
		// Exclusive create ("wx"): a pre-planted file (or symlink) at the temp
		// path makes the create fail instead of being hijacked, and the rename
		// below then never runs against attacker content. tempAcquired is set
		// as soon as the create succeeds, before the write: a write failure
		// after the create (a full disk, for example) leaves a temp fragment
		// this writer owns, and the failure cleanup below must remove it.
		const handle = await fs.open(tempPath, "wx")
		tempAcquired = true
		// Some filesystems (NFS in particular) report a quota or space failure
		// at close() rather than at write() time. A rejected close after a
		// resolved writeFile therefore still means the report may not be
		// durable; swallowing it would let the rename below publish a report
		// the filesystem already flagged. When the write itself also failed,
		// the original write error is preserved.
		let writeError: unknown
		try {
			await fs.writeFile(handle, params.markdown, { encoding: "utf8" })
		} catch (error) {
			writeError = error
		}
		try {
			await handle.close()
		} catch (closeError) {
			if (writeError === undefined) {
				writeError = closeError
			}
		}
		if (writeError !== undefined) {
			throw writeError
		}
		await fs.rename(tempPath, targetPath)
	} catch (error) {
		// Remove only the temp file this writer acquired. A pre-planted file
		// that made the exclusive create fail belongs to someone else; deleting
		// it would erase content the writer never owned. The target keeps its
		// previous content either way.
		if (tempAcquired) {
			await fs.rm(tempPath, { force: true }).catch(() => {})
		}
		throw error instanceof Error ? error : new Error(String(error))
	}

	return {
		path: targetPath,
		label: params.label,
		taskId: params.childTaskId,
		parentTaskId: params.parentTaskId,
	}
}
