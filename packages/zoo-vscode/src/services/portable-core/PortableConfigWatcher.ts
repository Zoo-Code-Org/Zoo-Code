import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"

import type { PortableCoreService } from "./PortableCoreService"

const DEBOUNCE_MS = 750

const PROJECT_PATTERNS = ["zoo.jsonc", "AGENTS.md", ".zooignore", ".zoo/rules/**/*.md", ".zoo/modes/*.json"]

/** Watches portable-core config files and invalidates CLI config caches after changes. */
export class PortableConfigWatcher implements vscode.Disposable {
	#disposables: vscode.Disposable[] = []
	#timer: ReturnType<typeof setTimeout> | undefined

	constructor(
		private readonly service: PortableCoreService,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.watchGlobalConfig()
		this.watchWorkspaceConfigs()
	}

	dispose(): void {
		if (this.#timer) {
			clearTimeout(this.#timer)
			this.#timer = undefined
		}
		for (const disposable of this.#disposables.splice(0)) disposable.dispose()
	}

	#schedule(uri: vscode.Uri): void {
		if (this.#timer) clearTimeout(this.#timer)
		const changedPath = uri.fsPath || uri.toString()
		this.#timer = setTimeout(() => {
			this.#timer = undefined
			void this.service.reloadConfig(changedPath)
		}, DEBOUNCE_MS)
	}

	private watchGlobalConfig(): void {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.join(os.homedir(), ".config", "zoo-code"), "zoo.jsonc"),
		)
		this.register(watcher)
	}

	private watchWorkspaceConfigs(): void {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const pattern of PROJECT_PATTERNS) {
				this.register(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern)))
			}
		}
	}

	private register(watcher: vscode.FileSystemWatcher): void {
		this.#disposables.push(
			watcher,
			watcher.onDidCreate((uri) => this.#schedule(uri)),
			watcher.onDidChange((uri) => this.#schedule(uri)),
			watcher.onDidDelete((uri) => this.#schedule(uri)),
		)
		this.outputChannel.appendLine("[PortableCore] Watching Zoo config files")
	}
}
