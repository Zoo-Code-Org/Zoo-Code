import * as vscode from "vscode"
import { CodeIndexManager } from "./manager"
import { CodeIndexDisposalError } from "./errors/code-index-disposal-error"

/** Creates and retains one code index manager per workspace path. */
export class CodeIndexManagerRegistry {
	private static managersByWorkspacePath = new Map<string, CodeIndexManager>()

	public static getInstance(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		const folder = this.resolveWorkspaceFolder(workspacePath)
		workspacePath = workspacePath || folder?.uri.fsPath
		if (!workspacePath) {
			return undefined
		}

		const managersByWorkspacePath = CodeIndexManagerRegistry.managersByWorkspacePath
		const existingManager = managersByWorkspacePath.get(workspacePath)
		if (existingManager) {
			return existingManager
		}

		// folder may be undefined when workspacePath was provided but doesn't match
		// any workspace folder (e.g. cwd passed from a tool). Fall back to file:// URI.
		const folderUri = folder?.uri ?? vscode.Uri.file(workspacePath)
		const manager = new CodeIndexManager(workspacePath, folderUri, context)
		managersByWorkspacePath.set(workspacePath, manager)
		return manager
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
		return Array.from(CodeIndexManagerRegistry.managersByWorkspacePath.values())
	}

	public static disposeAll(): void {
		const instances = this.getAllInstances()
		CodeIndexManagerRegistry.managersByWorkspacePath.clear()
		const errors: unknown[] = []
		for (const instance of instances) {
			try {
				instance.dispose()
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) {
			throw new CodeIndexDisposalError(errors)
		}
	}
}
