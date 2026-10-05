import * as vscode from "vscode"
import { Package } from "../../../shared/package"
import { BATCH_SEGMENT_THRESHOLD } from "../constants"

export function getEmbeddingBatchSize(): number {
	try {
		return vscode.workspace
			.getConfiguration(Package.name)
			.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
	} catch (error) {
		console.warn(
			`[getEmbeddingBatchSize] Failed to read codeIndex.embeddingBatchSize; using default ${BATCH_SEGMENT_THRESHOLD}.`,
			error,
		)
		return BATCH_SEGMENT_THRESHOLD
	}
}
