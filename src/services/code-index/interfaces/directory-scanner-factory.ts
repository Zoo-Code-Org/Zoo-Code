import type { Ignore } from "ignore"
import type { CacheManager } from "../cache-manager"
import type { ICodeParser, IDirectoryScanner, IEmbedder, IVectorStore } from "./index"

export interface DirectoryScannerFactoryOptions {
	embedder: IEmbedder
	vectorStore: IVectorStore
	parser: ICodeParser
	cacheManager: CacheManager
	ignoreInstance: Ignore
}

export interface IDirectoryScannerFactory {
	create(options: DirectoryScannerFactoryOptions): IDirectoryScanner
}
