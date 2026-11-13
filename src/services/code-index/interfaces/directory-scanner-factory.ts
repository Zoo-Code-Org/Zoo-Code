import type { Ignore } from "ignore"
import type { CacheManager } from "../cache-manager"
import type { FileFailureRegistry } from "../file-failure-registry"
import type { ProviderPacerRegistry } from "../provider-pacer"
import type { ICodeParser, IDirectoryScanner, IEmbedder, IVectorStore } from "./index"

export interface DirectoryScannerFactoryOptions {
	embedder: IEmbedder
	vectorStore: IVectorStore
	parser: ICodeParser
	cacheManager: CacheManager
	ignoreInstance: Ignore
	failureRegistry: FileFailureRegistry
	pacers: ProviderPacerRegistry
}

export interface IDirectoryScannerFactory {
	create(options: DirectoryScannerFactoryOptions): IDirectoryScanner
}
