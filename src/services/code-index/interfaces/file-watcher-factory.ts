import type * as vscode from "vscode"
import type { Ignore } from "ignore"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { CacheManager } from "../cache-manager"
import type { FileFailureRegistry } from "../file-failure-registry"
import type { ProviderPacerRegistry } from "../provider-pacer"
import type { IEmbedder, IFileWatcher, IVectorStore } from "./index"

export interface FileWatcherFactoryOptions {
	workspacePath: string
	context: vscode.ExtensionContext
	embedder: IEmbedder
	vectorStore: IVectorStore
	cacheManager: CacheManager
	ignoreInstance: Ignore
	rooIgnoreController?: RooIgnoreController
	failureRegistry: FileFailureRegistry
	pacers: ProviderPacerRegistry
}

export interface IFileWatcherFactory {
	create(options: FileWatcherFactoryOptions): IFileWatcher
}
