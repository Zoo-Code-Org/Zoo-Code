import type * as vscode from "vscode"
import type { Ignore } from "ignore"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { CacheManager } from "../cache-manager"
import type { IEmbedder, IFileWatcher, IVectorStore } from "./index"

export interface FileWatcherFactoryOptions {
	workspacePath: string
	context: vscode.ExtensionContext
	embedder: IEmbedder
	vectorStore: IVectorStore
	cacheManager: CacheManager
	ignoreInstance: Ignore
	rooIgnoreController?: RooIgnoreController
}

export interface IFileWatcherFactory {
	create(options: FileWatcherFactoryOptions): IFileWatcher
}
