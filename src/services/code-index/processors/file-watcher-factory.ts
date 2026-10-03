import type { IFileWatcher } from "../interfaces"
import type { FileWatcherFactoryOptions, IFileWatcherFactory } from "../interfaces/file-watcher-factory"
import { FileWatcher } from "./file-watcher"
import { getEmbeddingBatchSize } from "./get-embedding-batch-size"

export class FileWatcherFactory implements IFileWatcherFactory {
	constructor(private readonly options: FileWatcherFactoryOptions) {}

	public create(): IFileWatcher {
		const { workspacePath, context, cacheManager, embedder, vectorStore, ignoreInstance, rooIgnoreController } =
			this.options
		return new FileWatcher(
			workspacePath,
			context,
			cacheManager,
			embedder,
			vectorStore,
			ignoreInstance,
			rooIgnoreController,
			getEmbeddingBatchSize(),
		)
	}
}
