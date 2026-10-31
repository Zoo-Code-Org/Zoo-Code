import { t } from "../../../i18n"
import { getDefaultModelId, getModelDimension } from "../../../shared/embeddingModels"
import type { CodeIndexConfig } from "../interfaces/config"
import type { IVectorStore } from "../interfaces"
import type { IVectorStoreFactory } from "../interfaces/vector-store-factory"
import { QdrantVectorStore } from "./qdrant-client"

export class VectorStoreFactory implements IVectorStoreFactory {
	public create(config: CodeIndexConfig, workspacePath: string): IVectorStore {
		if (config.embedderProvider === "semble") {
			throw new Error(
				"Semble provider handles its own vector storage. Do not call createVectorStore() for semble — use SembleProvider instead.",
			)
		}

		const vectorSize = this.resolveVectorSize(config)

		if (!config.qdrantUrl) {
			throw new Error(t("embeddings:serviceFactory.qdrantUrlMissing"))
		}

		return new QdrantVectorStore(workspacePath, config.qdrantUrl, vectorSize, config.qdrantApiKey)
	}

	private resolveVectorSize(config: CodeIndexConfig): number {
		const provider = config.embedderProvider
		const modelId = config.modelId ?? getDefaultModelId(provider)
		let vectorSize = getModelDimension(provider, modelId)

		// A manual dimension is only a fallback for models without a built-in dimension.
		if (!vectorSize && config.modelDimension && config.modelDimension > 0) {
			vectorSize = config.modelDimension
		}

		if (vectorSize === undefined || vectorSize <= 0) {
			const errorKey =
				provider === "openai-compatible"
					? "embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible"
					: "embeddings:serviceFactory.vectorDimensionNotDetermined"
			throw new Error(t(errorKey, { modelId, provider }))
		}

		return vectorSize
	}
}
