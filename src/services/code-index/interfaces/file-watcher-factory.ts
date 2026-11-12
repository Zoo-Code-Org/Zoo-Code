import type * as vscode from "vscode"
import type { Ignore } from "ignore"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { CacheManager } from "../cache-manager"
import type { ICodeParser, IEmbedder, IFileWatcher, IVectorStore } from "./index"
import type { FileFailureRegistry } from "../file-failure-registry"
import type { IndexWriteGate } from "../index-write-gate"
import type { GenerationAllocator } from "../generation-allocator"
import type { ProviderPacerRegistry } from "../provider-pacer"

export interface FileWatcherFactoryOptions {
	workspacePath: string
	context: vscode.ExtensionContext
	embedder: IEmbedder
	vectorStore: IVectorStore
	cacheManager: CacheManager
	ignoreInstance: Ignore
	rooIgnoreController?: RooIgnoreController
	parser?: ICodeParser
	failures?: FileFailureRegistry
	writeGate?: IndexWriteGate
	generations?: GenerationAllocator
	isCurrentAttempt?: () => boolean
	providerPacers?: ProviderPacerRegistry
}

export interface IFileWatcherFactory {
	create(options: FileWatcherFactoryOptions): IFileWatcher
}
