import * as vscode from "vscode"

import { CodeIndexWorkspaceScope } from "./code-index-workspace-scope"

/** Resolves workspaces and owns their cached code-index scopes. */
export class CodeIndexWorkspaceScopeRegistry {
	public static readonly instance = new CodeIndexWorkspaceScopeRegistry()

	private readonly scopes = new Map<string, CodeIndexWorkspaceScope>()
	private disposing = false

	private constructor() {}

	public getScope(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexWorkspaceScope | undefined {
		if (this.disposing) {
			return undefined
		}
		const folder = this.resolveWorkspaceFolder(workspacePath)
		const resolvedPath = workspacePath || folder?.uri.fsPath
		if (!resolvedPath) {
			return undefined
		}

		const existing = this.scopes.get(resolvedPath)
		if (existing) {
			return existing
		}

		// Preserve real workspace URIs, including remote schemes and authorities.
		const folderUri = folder?.uri ?? vscode.Uri.file(resolvedPath)
		const scope = new CodeIndexWorkspaceScope(resolvedPath, folderUri, context)
		this.scopes.set(resolvedPath, scope)
		return scope
	}

	public getAllScopes(): CodeIndexWorkspaceScope[] {
		return Array.from(this.scopes.values())
	}

	public disposeAll(): void {
		if (this.disposing) {
			return
		}
		this.disposing = true
		const scopes = this.getAllScopes()
		this.scopes.clear()
		const errors: unknown[] = []
		try {
			for (const scope of scopes) {
				try {
					scope.dispose()
				} catch (error) {
					errors.push(error)
				}
			}
		} finally {
			this.disposing = false
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "Failed to dispose code index workspace scopes")
		}
	}

	private resolveWorkspaceFolder(workspacePath?: string): vscode.WorkspaceFolder | undefined {
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

/** Shared workspace scope registry used by the extension runtime. */
export const codeIndexWorkspaceScopeRegistry = CodeIndexWorkspaceScopeRegistry.instance
