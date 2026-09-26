import * as vscode from "vscode"
import type { CodeIndexManager } from "./manager"
import { CodeIndexWorkspaceScope } from "./code-index-workspace-scope"

/** Owns workspace scopes while preserving the manager-facing API. */
export class CodeIndexManagerRegistry {
	private static codeIndexWorkspaceScopes = new Map<string, CodeIndexWorkspaceScope>()

	public static getOrCreate(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		const folder = this.resolveWorkspaceFolder(workspacePath)
		const resolvedPath = workspacePath || folder?.uri.fsPath
		if (!resolvedPath) {
			return undefined
		}

		const existing = this.codeIndexWorkspaceScopes.get(resolvedPath)
		if (existing) {
			return existing.codeIndexManager
		}

		// Preserve real workspace URIs, including remote schemes and authorities.
		const folderUri = folder?.uri ?? vscode.Uri.file(resolvedPath)
		const codeIndexWorkspaceScope = new CodeIndexWorkspaceScope(resolvedPath, folderUri, context)
		codeIndexWorkspaceScope.init()
		this.codeIndexWorkspaceScopes.set(resolvedPath, codeIndexWorkspaceScope)
		return codeIndexWorkspaceScope.codeIndexManager
	}

	public static getAllInstances(): CodeIndexManager[] {
		return Array.from(this.codeIndexWorkspaceScopes.values(), (scope) => scope.codeIndexManager)
	}

	public static disposeAll(): void {
		for (const [workspacePath, codeIndexWorkspaceScope] of this.codeIndexWorkspaceScopes) {
			try {
				codeIndexWorkspaceScope.dispose()
			} catch (error) {
				console.error(
					`[CodeIndexManagerRegistry] Failed to dispose workspace scope for ${workspacePath}:`,
					error,
				)
			}
		}
		this.codeIndexWorkspaceScopes.clear()
	}

	private static resolveWorkspaceFolder(workspacePath?: string): vscode.WorkspaceFolder | undefined {
		if (workspacePath) {
			return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.fsPath === workspacePath)
		}

		const activeEditor = vscode.window.activeTextEditor
		if (activeEditor) {
			const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
			if (folder) {
				return folder
			}
		}

		return vscode.workspace.workspaceFolders?.[0]
	}
}
