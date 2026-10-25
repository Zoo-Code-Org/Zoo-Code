import type * as vscode from "vscode"
import { Ignore } from "ignore"

import { t } from "../../i18n"

import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"

import { EmbedderFactory } from "./embedders/embedder-factory"
import { EmbedderValidationManager } from "./embedders/embedder-validation-manager"
import { VectorStoreFactory } from "./vector-store/vector-store-factory"
import { codeParser, DirectoryScanner } from "./processors"
import { DirectoryScannerFactory } from "./processors/directory-scanner-factory"
import { FileWatcherFactory } from "./processors/file-watcher-factory"
import { ICodeParser, IEmbedder, IFileWatcher, IVectorStore } from "./interfaces"
import { CodeIndexConfigManager } from "./config-manager"
import { CacheManager } from "./cache-manager"

/**
 * Factory class responsible for creating and configuring code indexing service dependencies.
 */
export class CodeIndexServiceFactory {
	// TODO: Remove all factory and validation manager dependencies below once the workspace scope
	// supplies them to CodeIndexManager via DI and it calls them directly.
	// https://github.com/Zoo-Code-Org/Zoo-Code/issues/1817
	private readonly embedderFactory = new EmbedderFactory()
	private readonly vectorStoreFactory = new VectorStoreFactory()
	private readonly directoryScannerFactory = new DirectoryScannerFactory()
	private readonly fileWatcherFactory = new FileWatcherFactory()
	private readonly embedderValidationManager = new EmbedderValidationManager()

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
	) {}

	/**
	 * Validates an embedder instance to ensure it's properly configured.
	 * @param embedder The embedder instance to validate
	 * @returns Promise resolving to validation result
	 */
	// TODO: Remove this proxy and have CodeIndexManager call the injected validation manager directly.
	// https://github.com/Zoo-Code-Org/Zoo-Code/issues/1817
	public validateEmbedder(embedder: IEmbedder): Promise<{ valid: boolean; error?: string }> {
		return this.embedderValidationManager.validateEmbedder(embedder)
	}

	/**
	 * Creates all required service dependencies if the service is properly configured.
	 * @throws Error if the service is not properly configured
	 */
	public createServices(
		context: vscode.ExtensionContext,
		cacheManager: CacheManager,
		ignoreInstance: Ignore,
		rooIgnoreController?: RooIgnoreController,
	): {
		embedder: IEmbedder
		vectorStore: IVectorStore
		parser: ICodeParser
		scanner: DirectoryScanner
		fileWatcher: IFileWatcher
	} {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error(t("embeddings:serviceFactory.codeIndexingNotConfigured"))
		}

		const config = this.configManager.getConfig()
		const embedder = this.embedderFactory.create(config)
		const vectorStore = this.vectorStoreFactory.create(config, this.workspacePath)
		const parser = codeParser
		const scanner = this.directoryScannerFactory.create({
			embedder,
			vectorStore,
			parser,
			cacheManager: this.cacheManager,
			ignoreInstance,
		})
		const fileWatcher = this.fileWatcherFactory.create({
			workspacePath: this.workspacePath,
			context,
			embedder,
			vectorStore,
			cacheManager,
			ignoreInstance,
			rooIgnoreController,
		})

		return {
			embedder,
			vectorStore,
			parser,
			scanner,
			fileWatcher,
		}
	}
}
