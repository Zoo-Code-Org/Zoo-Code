import type { CodeIndexConfig } from "./config"
import type { IVectorStore } from "./index"

export interface IVectorStoreFactory {
	create(config: CodeIndexConfig, workspacePath: string): IVectorStore
}
