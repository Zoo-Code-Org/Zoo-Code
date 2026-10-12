import type { CodeIndexConfig } from "./config"
import type { IEmbedder } from "./index"

/** Creates a vector embedder, validating the provider's required configuration. */
export interface IEmbedderFactory {
	create(config: CodeIndexConfig): IEmbedder
}
