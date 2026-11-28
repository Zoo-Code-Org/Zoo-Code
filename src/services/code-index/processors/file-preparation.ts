import { createHash } from "crypto"
import { Uri } from "vscode"
import { v5 as uuidv5 } from "uuid"
import type { CodeBlock, FileProcessingResult, PointStruct } from "../interfaces"
import type { FilePreparationDependencies } from "./file-preparation-dependencies"
import { MAX_FILE_SIZE_BYTES, QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { createPacedEmbeddings } from "../shared/retry-policy"

/** Prepares one file for batching without writing points or mutating the hash cache. */
export class FilePreparation {
	constructor(private readonly dependencies: FilePreparationDependencies) {}

	public async prepareFile(filePath: string): Promise<FileProcessingResult> {
		const dependencies = this.dependencies
		let embeddingOutcome: FileProcessingResult["embeddingOutcome"]
		try {
			const skipReason = await this.getSkipReason(filePath)
			if (skipReason !== undefined) {
				return this.skippedResult(filePath, skipReason)
			}

			const fileContent = await dependencies.fileSystem.readFile(Uri.file(filePath))
			const content = Buffer.from(fileContent).toString("utf-8")
			const newHash = createHash("sha256").update(content).digest("hex")

			if (dependencies.cacheManager.getHash(filePath) === newHash) {
				return this.skippedResult(filePath, "File has not changed")
			}

			const blocks = await dependencies.parser.parseFile(filePath, { content, fileHash: newHash })
			let pointsToUpsert: PointStruct[] = []
			if (dependencies.embedder && blocks.length > 0) {
				let embeddings: number[][]
				try {
					const result = await createPacedEmbeddings(
						dependencies.embedder,
						dependencies.pacers,
						blocks.map((block) => block.content),
						undefined,
						filePath,
					)
					embeddingOutcome = "success"
					embeddings = result.embeddings
				} catch (error) {
					return { path: filePath, status: "local_error", error: error as Error, embeddingOutcome: "failure" }
				}
				pointsToUpsert = this.preparePoints(blocks, embeddings)
			}

			return {
				path: filePath,
				status: "processed_for_batching",
				newHash,
				pointsToUpsert,
				...(embeddingOutcome ? { embeddingOutcome } : {}),
			}
		} catch (error) {
			return {
				path: filePath,
				status: "local_error",
				error: error as Error,
				...(embeddingOutcome ? { embeddingOutcome } : {}),
			}
		}
	}

	private async getSkipReason(filePath: string): Promise<string | undefined> {
		const dependencies = this.dependencies
		// Use relative paths so ignored directories outside the workspace do not exclude the file.
		const relativeFilePath = generateRelativeFilePath(filePath, dependencies.workspacePath)
		if (isPathInIgnoredDirectory(relativeFilePath)) {
			return "File is in an ignored directory"
		}

		if (
			!dependencies.ignoreController.validateAccess(filePath) ||
			dependencies.ignoreInstance?.ignores(relativeFilePath)
		) {
			return "File is ignored by .rooignore or .gitignore"
		}

		const fileStat = await dependencies.fileSystem.stat(Uri.file(filePath))
		if (fileStat.size > MAX_FILE_SIZE_BYTES) {
			return "File is too large"
		}
		return undefined
	}

	private skippedResult(filePath: string, reason: string): FileProcessingResult {
		return { path: filePath, status: "skipped", reason }
	}

	private preparePoints(blocks: CodeBlock[], embeddings: number[][]): PointStruct[] {
		const dependencies = this.dependencies

		return blocks.map((block, index) => {
			const normalizedAbsolutePath = generateNormalizedAbsolutePath(block.file_path, dependencies.workspacePath)
			const stableName = `${normalizedAbsolutePath}:${block.start_line}`
			const pointId = uuidv5(stableName, QDRANT_CODE_BLOCK_NAMESPACE)

			return {
				id: pointId,
				vector: embeddings[index],
				payload: {
					filePath: generateRelativeFilePath(normalizedAbsolutePath, dependencies.workspacePath),
					codeChunk: block.content,
					startLine: block.start_line,
					endLine: block.end_line,
				},
			}
		})
	}
}
