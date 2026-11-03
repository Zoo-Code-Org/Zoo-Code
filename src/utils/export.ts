import * as vscode from "vscode"
import * as path from "path"
import { access, constants, stat } from "fs/promises"

export interface ExportContext {
	getValue(key: string): unknown
	setValue(key: string, value: unknown): Promise<void>
}

export interface ExportOptions {
	/**
	 * Whether to consider the active workspace folder as a default location.
	 * Default: true
	 */
	useWorkspace?: boolean
	/**
	 * Fallback directory if no previous path or workspace is available.
	 */
	fallbackDir?: string
	/**
	 * The permission the remembered directory must still have to be used as the dialog
	 * default, as an `fs/promises` access constant. A save target has to be writable
	 * (`constants.W_OK`); an open dialog only has to be readable (`constants.R_OK`),
	 * otherwise a read-only folder that actually holds the file would be skipped in
	 * favour of the fallback directory.
	 * Default: constants.W_OK
	 */
	accessMode?: number
}

/**
 * Whether a directory can actually receive a saved file right now.
 *
 * A remembered export location is frequently on a removable or network drive
 * that is gone by the next export (unmounted, or remounted under a different
 * drive letter). Handing such a path to `showSaveDialog` does not fail loudly:
 * the platform silently falls back to its own default folder, so the file lands
 * somewhere the user never selected. Validating the directory first lets the
 * resolver fall through to the documented priorities instead.
 */
async function isUsableSaveDirectory(dirPath: string, accessMode: number): Promise<boolean> {
	try {
		const stats = await stat(dirPath)
		if (!stats.isDirectory()) {
			return false
		}
		// The access bits are what matter: a readable-but-read-only volume cannot
		// receive an export, while an open dialog only reads from it. X_OK is ORed in
		// because R_OK/W_OK alone do not test traversal, and a directory that cannot be
		// searched cannot resolve a file inside it. Node ignores X_OK on Windows.
		await access(dirPath, accessMode | constants.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * Resolves the default save URI for an export operation.
 * Priorities:
 * 1. Last used export path, if that directory still exists and still has the
 *    access the caller needs (writable for a save, readable for an open)
 * 2. Active workspace folder (if useWorkspace is true)
 * 3. Fallback directory (e.g. Downloads or Documents)
 * 4. Default to just the filename (user's home/cwd)
 */
export async function resolveDefaultSaveUri(
	context: ExportContext,
	configKey: string,
	fileName: string,
	options: ExportOptions = {},
): Promise<vscode.Uri> {
	const { useWorkspace = true, fallbackDir, accessMode = constants.W_OK } = options
	const lastExportPath = context.getValue(configKey) as string | undefined

	if (lastExportPath) {
		// Use the directory from the last export, but only while it is still a
		// directory we can actually reach with the access this operation needs.
		const lastDir = path.dirname(lastExportPath)
		if (await isUsableSaveDirectory(lastDir, accessMode)) {
			return vscode.Uri.file(path.join(lastDir, fileName))
		}
	}

	// Try workspace if enabled
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (useWorkspace && workspaceFolders && workspaceFolders.length > 0) {
		return vscode.Uri.file(path.join(workspaceFolders[0].uri.fsPath, fileName))
	}

	// Fallback
	if (fallbackDir) {
		return vscode.Uri.file(path.join(fallbackDir, fileName))
	}

	// Default to cwd/home
	return vscode.Uri.file(fileName)
}

export async function saveLastExportPath(context: ExportContext, configKey: string, uri: vscode.Uri) {
	await context.setValue(configKey, uri.fsPath)
}
