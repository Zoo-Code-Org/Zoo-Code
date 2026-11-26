import type { CodeIndexConfig } from "./config"
import type { IVectorStore } from "./index"
import type { ProviderPacerRegistry } from "../provider-pacer"

export interface IVectorStoreFactory {
	create(config: CodeIndexConfig, workspacePath: string, pacers: ProviderPacerRegistry): IVectorStore
}
