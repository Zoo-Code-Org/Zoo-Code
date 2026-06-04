import * as path from "path"
import * as fs from "fs/promises"

/** Narrow an unknown error to a Node errno exception with the given `code`. */
function isErrnoException(err: unknown, code: string): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === code
}

// macOS APFS/HFS+ and Windows are case-insensitive: `realpath` can return a different case
// than the one VS Code registered, so we lowercase the result before returning to keep later
// comparisons (e.g. against `uri.fsPath`) reliable on those platforms only. Platform is read at
// call time (not cached) so the behavior stays correct and testable.
function normalizeCase(p: string): string {
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32"
	return caseInsensitive ? p.toLowerCase() : p
}

/**
 * Resolve a filesystem path to its canonical, symlink-followed form.
 *
 * This is the canonicalization primitive for the workspace boundary check (issue #169). It owns
 * **only** path resolution — no workspace policy, no settings, no tool logic. The authorization
 * decision (and the `allowSymlinksOutsideWorkspace` opt-in) lives in `WorkspaceFileAccess`.
 *
 * Behavior:
 * - **Async only** (`fs.promises.realpath`); never blocks the extension host event loop.
 * - If `target` does not exist yet (e.g. a file about to be created), the realpath of the nearest
 *   existing ancestor is resolved and the remaining segments are re-appended, so a symlink
 *   anywhere along the path is still followed while not-yet-created paths can still be evaluated.
 * - Only `ENOENT` triggers the walk-up. Any other error (e.g. `EACCES`, `ELOOP`) is **re-thrown**
 *   so a caller performing a security check can fail closed. Silently walking up would mask the
 *   symlink and could make an out-of-workspace target look "inside" (#169).
 * - The result is case-normalized on case-insensitive filesystems (macOS, Windows).
 *
 * Workspace folder paths should be resolved through this same function by callers, since a folder
 * may itself be reached via a symlink. Callers should always compare two `resolveRealPath()` results
 * rather than mixing with raw `uri.fsPath` — `arePathsEqual()` does not case-fold on macOS.
 */
export async function resolveRealPath(target: string): Promise<string> {
	let current = path.resolve(target)
	const trailing: string[] = []

	// Walk up until an existing path can be resolved, bounded by the filesystem root.
	while (true) {
		try {
			const resolved = await fs.realpath(current)
			const joined = trailing.length > 0 ? path.join(resolved, ...trailing.reverse()) : resolved
			return normalizeCase(joined)
		} catch (err) {
			if (!isErrnoException(err, "ENOENT")) {
				// Non-ENOENT (e.g. EACCES, ELOOP, ENOTDIR): propagate so the caller's
				// security check can fail closed instead of falling through to the lexical path.
				throw err
			}

			const parent = path.dirname(current)
			if (parent === current) {
				// Reached the filesystem root without finding an existing path; fall back to the
				// lexically resolved path (still case-normalized for consistent comparisons).
				return normalizeCase(path.resolve(target))
			}

			trailing.push(path.basename(current))
			current = parent
		}
	}
}
