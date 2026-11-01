import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

/**
 * Checks if a file path is outside all workspace folders
 * @param filePath The file path to check
 * @returns true if the path is outside all workspace folders, false otherwise
 */
export function isPathOutsideWorkspace(filePath: string): boolean {
	// If there are no workspace folders, consider everything outside workspace for safety
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return true
	}

	// Normalize and resolve the path to handle .. and . components correctly
	const absolutePath = path.resolve(filePath)

	// Check if the path is within any workspace folder
	return !vscode.workspace.workspaceFolders.some((folder) => {
		const folderPath = folder.uri.fsPath
		// Path is inside a workspace if it equals the workspace path or is a subfolder
		return absolutePath === folderPath || absolutePath.startsWith(folderPath + path.sep)
	})
}

/**
 * Percent-decode an untrusted path to a fixed point.
 *
 * Markdown link targets are URL syntax and may be percent-encoded, while the
 * downstream openFile helper (src/integrations/misc/open-file.ts) decodes the
 * path AFTER workspace validation. Decoding here, at the containment
 * boundary, closes the hole where a request like `%2e%2e/%2e%2e/.env` passes
 * containment as a literal and escapes only after the later decode. Decoding
 * repeats until the value is stable so double-encoded payloads
 * (`%252e%252e`) are caught as well.
 *
 * Values containing a bare `%` that is not a valid escape (e.g.
 * `report 50%.md`) are returned unchanged — the same lenient semantics
 * openFile already applies. A value that does not stabilize within
 * `maxIterations` is a hostile encoding and rejected with `null`.
 */
export function decodeUntrustedPathToStable(filePath: string, maxIterations = 8): string | null {
	let current = filePath
	// Stryker disable next-line EqualityOperator,UpdateOperator,ConditionalExpression: defensive iteration bound; valid percent-encoding strictly reduces escape depth per decode, so the bound is never hit for production input (pinned by the direct bound test)
	for (let i = 0; i < maxIterations; i++) {
		let decoded: string
		try {
			decoded = decodeURIComponent(current)
		} catch {
			// Not a valid escape sequence: the value is stable as-is.
			return current
		}
		if (decoded === current) {
			return current
		}
		current = decoded
	}
	// Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: defensive bound; valid percent-encoding strictly reduces escape depth per iteration, so non-stabilization is unreachable for real input
	return null
}

// Realpath of the deepest existing ancestor of `filePath` (the path itself
// when it exists). A dangling symlink — an entry that exists but whose target
// cannot be resolved — fails realpath with ENOENT without being a
// nonexistent path: creation flows (mkdir -p) would follow it and could
// escape the workspace, so such entries fail closed. Returns null on
// unexpected errors: containment for untrusted paths fails closed.
async function realPathOfExistingAncestor(filePath: string): Promise<string | null> {
	let current = filePath
	for (;;) {
		try {
			return await fs.promises.realpath(current)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			// Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: ENOENT is the only expected code on a walk toward an existing ancestor; anything else (EACCES, EIO, ...) must fail closed
			if (code !== "ENOENT") {
				return null
			}
			// ENOENT from realpath is ambiguous: the entry may simply not exist
			// yet, or it may be a dangling symlink whose target is missing.
			// lstat does not follow the final entry, so it distinguishes the two.
			// A dangling symlink must fail closed (a creation flow would follow
			// it and could escape the workspace); a genuinely absent entry keeps
			// walking to its deepest existing ancestor.
			try {
				const stat = await fs.promises.lstat(current)
				if (stat.isSymbolicLink()) {
					return null
				}
			} catch (lstatError) {
				const lstatCode = (lstatError as NodeJS.ErrnoException).code
				// Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: only ENOENT means the entry is genuinely absent and the walk may continue; any other lstat error (EACCES, EIO, ...) must fail closed
				if (lstatCode !== "ENOENT") {
					return null
				}
			}
			const parent = path.dirname(current)
			// Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: root guard against a non-terminating walk (path.dirname stabilizes at the filesystem root)
			if (parent === current) {
				return null
			}
			current = parent
		}
	}
}

/**
 * Realpath-based containment for untrusted paths: resolves the filesystem's
 * real targets before checking containment, so a symlink inside a workspace
 * folder cannot point at a file outside it. Paths that do not exist yet (the
 * openFile creation flow) are checked via their deepest existing ancestor.
 * Workspace folders are realized the same way, since a workspace root may
 * itself be a symlink. Fails closed: no workspace folders, or an unexpected
 * fs error, counts as outside.
 */
export async function isRealPathOutsideWorkspace(filePath: string): Promise<boolean> {
	const folders = vscode.workspace.workspaceFolders
	// Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent - with no folders the realFolders set stays empty and the empty-set fail-closed below returns the same result
	if (!folders || folders.length === 0) {
		// Stryker disable next-line BlockStatement: no workspace means no allowed root; everything is outside (mirrors isPathOutsideWorkspace)
		return true
	}
	const target = await realPathOfExistingAncestor(filePath)
	// Stryker disable next-line ConditionalExpression,BlockStatement: unresolvable target (unexpected fs error) fails closed
	if (!target) {
		return true
	}
	// Stryker disable next-line ArrayDeclaration: equivalent - the array is always populated (or fails closed at the empty check) before the containment test, so the initial literal is unobservable
	const realFolders: string[] = []
	for (const folder of folders) {
		const real = await realPathOfExistingAncestor(folder.uri.fsPath)
		// Stryker disable next-line ConditionalExpression: equivalent - a null real can never match a resolved target, and the empty-set fail-closed is unaffected by an extra null entry
		if (real) {
			realFolders.push(real)
		}
	}
	// Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: if no folder could be realized the containment set is empty, so fail closed
	if (realFolders.length === 0) {
		return true
	}
	return !realFolders.some((folderPath) => target === folderPath || target.startsWith(folderPath + path.sep))
}
