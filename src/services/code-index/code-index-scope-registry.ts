import * as vscode from "vscode"
import { CodeIndexScope } from "./code-index-scope"
import { CodeIndexDisposalError } from "./errors/code-index-disposal-error"

/** Creates and retains one code index scope per workspace path. */
export class CodeIndexScopeRegistry {
	public static readonly instance = new CodeIndexScopeRegistry()

	private scopesByWorkspacePath = new Map<string, CodeIndexScope>()
	private isDisposing = false

	private constructor() {}

	public getScope(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexScope | undefined {
		if (this.isDisposing) {
			return undefined
		}

		const folder = this.resolveWorkspaceFolder(workspacePath)
		const resolvedPath = workspacePath ?? folder?.uri.fsPath
		if (!resolvedPath) {
			return undefined
		}

		const existingScope = this.scopesByWorkspacePath.get(resolvedPath)
		if (existingScope) {
			return existingScope
		}

		// folder may be undefined when workspacePath was provided but doesn't match
		// any workspace folder (e.g. cwd passed from a tool). Fall back to file:// URI.
		const folderUri = folder?.uri ?? vscode.Uri.file(resolvedPath)
		const scope = new CodeIndexScope(resolvedPath, folderUri, context)
		this.scopesByWorkspacePath.set(resolvedPath, scope)
		return scope
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

	public getAllScopes(): CodeIndexScope[] {
		return Array.from(this.scopesByWorkspacePath.values())
	}

	public async disposeAll(): Promise<void> {
		const scopes = this.getAllScopes()
		this.scopesByWorkspacePath.clear()
		this.isDisposing = true
		const errors: unknown[] = []
		try {
			for (const scope of scopes) {
				try {
					await scope.dispose()
				} catch (error) {
					errors.push(error)
				}
			}
		} finally {
			this.isDisposing = false
		}
		if (errors.length > 0) {
			throw new CodeIndexDisposalError(errors)
		}
	}
}

export const codeIndexScopeRegistry = CodeIndexScopeRegistry.instance
