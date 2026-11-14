import type { CodeIndexConfig } from "./config"
import type { IEmbedder } from "./index"
import type { ProviderPacerRegistry } from "../provider-pacer"

/** Creates a vector embedder, validating the provider's required configuration. */
export interface IEmbedderFactory {
	create(config: CodeIndexConfig, pacers: ProviderPacerRegistry): IEmbedder
}
