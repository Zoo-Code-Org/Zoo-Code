import type { Ignore } from "ignore"
import type { CacheManager } from "../cache-manager"
import type { ICodeParser, IDirectoryScanner, IEmbedder, IVectorStore } from "./index"
import type { FileFailureRegistry } from "../file-failure-registry"
import type { IndexWriteGate } from "../index-write-gate"
import type { GenerationAllocator } from "../generation-allocator"
import type { ProviderPacerRegistry } from "../provider-pacer"

export interface DirectoryScannerFactoryOptions {
	embedder: IEmbedder
	vectorStore: IVectorStore
	parser: ICodeParser
	cacheManager: CacheManager
	ignoreInstance: Ignore
	failures?: FileFailureRegistry
	writeGate?: IndexWriteGate
	generations?: GenerationAllocator
	workspacePath?: string
	isCurrentAttempt?: () => boolean
	providerPacers?: ProviderPacerRegistry
}

export interface IDirectoryScannerFactory {
	create(options: DirectoryScannerFactoryOptions): IDirectoryScanner
}
