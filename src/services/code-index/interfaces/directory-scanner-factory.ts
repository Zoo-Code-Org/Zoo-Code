import type { Ignore } from "ignore"
import type { CacheManager } from "../cache-manager"
import type { ICodeParser, IDirectoryScanner, IEmbedder, IVectorStore } from "./index"
import type { ProviderPacerRegistry } from "../provider-pacer"

export interface DirectoryScannerFactoryOptions {
	embedder: IEmbedder
	vectorStore: IVectorStore
	parser: ICodeParser
	cacheManager: CacheManager
	ignoreInstance: Ignore
	pacers: ProviderPacerRegistry
}

export interface IDirectoryScannerFactory {
	create(options: DirectoryScannerFactoryOptions): IDirectoryScanner
}
