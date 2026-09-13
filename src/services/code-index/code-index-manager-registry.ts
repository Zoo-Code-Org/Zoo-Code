import * as vscode from "vscode"
import { CodeIndexManager } from "./manager"
import { CodeIndexScope } from "./code-index-scope"
import { CodeIndexDisposalError } from "./errors/code-index-disposal-error"

/** Creates and retains one code index scope per workspace path. */
export class CodeIndexManagerRegistry {
	private static scopesByWorkspacePath = new Map<string, CodeIndexScope>()

	public static getInstance(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		return this.getCodeIndexScope(context, workspacePath)?.codeIndexManager
	}

	public static getCodeIndexScope(
		context: vscode.ExtensionContext,
		workspacePath?: string,
	): CodeIndexScope | undefined {
		const folder = this.resolveWorkspaceFolder(workspacePath)
		workspacePath = workspacePath || folder?.uri.fsPath
		if (!workspacePath) {
			return undefined
		}

		const scopesByWorkspacePath = CodeIndexManagerRegistry.scopesByWorkspacePath
		const existingScope = scopesByWorkspacePath.get(workspacePath)
		if (existingScope) {
			return existingScope
		}

		// folder may be undefined when workspacePath was provided but doesn't match
		// any workspace folder (e.g. cwd passed from a tool). Fall back to file:// URI.
		const folderUri = folder?.uri ?? vscode.Uri.file(workspacePath)
		const codeIndexScope = new CodeIndexScope(workspacePath, folderUri, context)
		scopesByWorkspacePath.set(workspacePath, codeIndexScope)
		return codeIndexScope
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

	public static getAllInstances(): CodeIndexManager[] {
		return Array.from(CodeIndexManagerRegistry.scopesByWorkspacePath.values(), (scope) => scope.codeIndexManager)
	}

	public static getAllCodeIndexScopes(): CodeIndexScope[] {
		return Array.from(CodeIndexManagerRegistry.scopesByWorkspacePath.values())
	}

	public static disposeAll(): void {
		const scopes = Array.from(CodeIndexManagerRegistry.scopesByWorkspacePath.values())
		CodeIndexManagerRegistry.scopesByWorkspacePath.clear()
		const errors: unknown[] = []
		for (const scope of scopes) {
			try {
				scope.dispose()
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) {
			throw new CodeIndexDisposalError(errors)
		}
	}
}
