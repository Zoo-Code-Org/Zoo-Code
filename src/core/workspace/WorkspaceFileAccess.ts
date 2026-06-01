import * as path from "path"

import * as vscode from "vscode"

import type { Task } from "../task/Task"
import { resolveRealPath } from "../../utils/WorkspacePathResolver"

/**
 * Why an authorization was denied. Distinguishing `symlink_escapes_workspace` from
 * `outside_workspace` lets callers (and telemetry) tell a deliberate out-of-tree path apart from a
 * path that *looks* inside the workspace but resolves out of it via a symlink (#169).
 */
export type AuthorizeDenyReason =
	| "outside_workspace"
	| "symlink_escapes_workspace"
	| "realpath_failed"
	| "permission_denied"

export type AuthorizeResult =
	| { ok: true; resolvedPath: string }
	| { ok: false; reason: AuthorizeDenyReason; message: string }

export interface AuthorizeOptions {
	/** Task whose provider state supplies the `allowSymlinksOutsideWorkspace` opt-in. */
	task: Task
	/** Absolute path as supplied by the tool. */
	requestedPath: string
	/** Tool name, used to prefix error messages. */
	source: string
}

/** Lowercase on case-insensitive filesystems, matching {@link resolveRealPath}'s own normalization. */
function normalizeCase(p: string): string {
	return process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p
}

/** True when `child` is `parent` itself or nested under it. Both paths must already be normalized. */
function isContained(parent: string, child: string): boolean {
	return child === parent || child.startsWith(parent + path.sep)
}

/**
 * Read the `allowSymlinksOutsideWorkspace` opt-in from provider state, defaulting to `false`
 * (fail-closed). The provider may have been torn down mid-operation, in which case `getState()`
 * rejects — that must not abort the file operation, so we swallow it and keep the safe default.
 */
async function readAllowSymlinksOutsideWorkspace(task: Task): Promise<boolean> {
	try {
		return (await task.providerRef.deref()?.getState())?.allowSymlinksOutsideWorkspace ?? false
	} catch {
		return false
	}
}

/**
 * Central authorization for file access against the workspace boundary.
 *
 * Tools call this instead of doing a raw `isPathOutsideWorkspace()` boolean check followed by their
 * own `fs` operation. The decoupled check-then-act pattern is structurally easy to get wrong — one
 * missed call site (like `ApplyDiffTool` in #241) leaves a hole. Here a tool requests an authorized
 * operation and gets back either a resolved path it may use, or a structured error it must surface.
 *
 * Default (fail-closed) behavior follows symlinks: the requested path and every workspace folder are
 * canonicalized via {@link resolveRealPath}, and access is granted only when the real path lands
 * inside a real workspace folder. When the user opts in via `allowSymlinksOutsideWorkspace`, the
 * pre-#169 lexical behavior is restored (symlinks are not followed for the boundary decision).
 *
 * This layer owns policy only — it performs no `fs` read/write itself.
 */
async function authorize(options: AuthorizeOptions): Promise<AuthorizeResult> {
	const { task, requestedPath, source } = options
	const allowSymlinksOutsideWorkspace = await readAllowSymlinksOutsideWorkspace(task)

	// Canonicalize the requested path (follows symlinks; walks up to the nearest existing ancestor
	// for not-yet-created files). A non-ENOENT error here means we can't prove anything about the
	// path, so we fail closed with a structured reason.
	let resolvedPath: string
	try {
		resolvedPath = await resolveRealPath(requestedPath)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		const detail = err instanceof Error ? err.message : String(err)
		if (code === "EACCES" || code === "EPERM") {
			return {
				ok: false,
				reason: "permission_denied",
				message: `[${source}] Permission denied resolving ${requestedPath}: ${detail}`,
			}
		}
		return {
			ok: false,
			reason: "realpath_failed",
			message: `[${source}] Could not resolve real path for ${requestedPath}: ${detail}`,
		}
	}

	const folders = vscode.workspace.workspaceFolders ?? []

	// Opt-in: restore pre-#169 lexical behavior — compare the literal path, never the symlink target.
	if (allowSymlinksOutsideWorkspace) {
		const lexicalPath = normalizeCase(path.resolve(requestedPath))
		const insideLexically = folders.some((folder) =>
			isContained(normalizeCase(path.resolve(folder.uri.fsPath)), lexicalPath),
		)
		if (insideLexically) {
			return { ok: true, resolvedPath }
		}
		return {
			ok: false,
			reason: "outside_workspace",
			message: `[${source}] ${requestedPath} is outside the workspace.`,
		}
	}

	// Fail-closed: with no workspace open nothing can be proven inside.
	if (folders.length === 0) {
		return {
			ok: false,
			reason: "outside_workspace",
			message: `[${source}] No workspace folder is open; ${requestedPath} cannot be authorized.`,
		}
	}

	// Compare the resolved path against each *resolved* workspace folder. A folder we can't resolve
	// (e.g. permissions) can't prove containment, so it's skipped rather than treated as a match.
	for (const folder of folders) {
		let resolvedFolder: string
		try {
			resolvedFolder = await resolveRealPath(folder.uri.fsPath)
		} catch {
			continue
		}
		if (isContained(resolvedFolder, resolvedPath)) {
			return { ok: true, resolvedPath }
		}
	}

	// Outside every folder. If the literal path looked inside but the resolved path escaped, a
	// symlink is responsible — surface that distinctly from a plainly out-of-workspace path.
	const lexicalPath = normalizeCase(path.resolve(requestedPath))
	const lexicallyInside = folders.some((folder) =>
		isContained(normalizeCase(path.resolve(folder.uri.fsPath)), lexicalPath),
	)
	if (lexicallyInside) {
		return {
			ok: false,
			reason: "symlink_escapes_workspace",
			message: `[${source}] ${requestedPath} resolves via symlink to ${resolvedPath}, which is outside the workspace.`,
		}
	}
	return {
		ok: false,
		reason: "outside_workspace",
		message: `[${source}] ${requestedPath} is outside the workspace.`,
	}
}

/** Authorize a read against the workspace boundary. See {@link authorize}. */
export function authorizeRead(options: AuthorizeOptions): Promise<AuthorizeResult> {
	return authorize(options)
}

/** Authorize a write against the workspace boundary. See {@link authorize}. */
export function authorizeWrite(options: AuthorizeOptions): Promise<AuthorizeResult> {
	return authorize(options)
}
