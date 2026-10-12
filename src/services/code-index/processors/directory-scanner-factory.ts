import type { DirectoryScannerFactoryOptions, IDirectoryScannerFactory } from "../interfaces/directory-scanner-factory"
import { DirectoryScanner } from "./scanner"
import { getEmbeddingBatchSize } from "./get-embedding-batch-size"

export class DirectoryScannerFactory implements IDirectoryScannerFactory {
	public create({
		embedder,
		vectorStore,
		parser,
		cacheManager,
		ignoreInstance,
	}: DirectoryScannerFactoryOptions): DirectoryScanner {
		return new DirectoryScanner(
			embedder,
			vectorStore,
			parser,
			cacheManager,
			ignoreInstance,
			getEmbeddingBatchSize(),
		)
	}
}
