import { createHash } from "crypto"
import { Uri } from "vscode"
import type { FileProcessingResult } from "../interfaces"
import type { FilePreparationDependencies } from "./file-preparation-dependencies"
import { MAX_FILE_SIZE_BYTES } from "../constants"
import { generateRelativeFilePath } from "../shared/get-relative-path"
import { readSource, SOURCE_MISSING } from "../shared/indexing-errors"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"

/** Prepares one file for batching without embedding, writing points or mutating the hash cache. */
export class FilePreparation {
	constructor(private readonly dependencies: FilePreparationDependencies) {}

	public async prepareFile(filePath: string): Promise<FileProcessingResult> {
		const dependencies = this.dependencies
		let content: string
		try {
			const skipReason = await this.getSkipReason(filePath)
			if (skipReason === SOURCE_MISSING) return { path: filePath, status: "missing" }
			if (skipReason !== undefined) return this.skippedResult(filePath, skipReason)

			const fileContent = await readSource(dependencies.fileSystem.readFile(Uri.file(filePath)))
			if (fileContent === SOURCE_MISSING) return { path: filePath, status: "missing" }
			content = Buffer.from(fileContent).toString("utf-8")
		} catch (error) {
			return { path: filePath, status: "local_error", activity: "read", error: error as Error }
		}

		try {
			const newHash = createHash("sha256").update(content).digest("hex")
			if (dependencies.cacheManager.getHash(filePath) === newHash) {
				return this.skippedResult(filePath, "File has not changed")
			}
			const blocks = await dependencies.parser.parseFile(filePath, { content, fileHash: newHash })
			return { path: filePath, status: "processed_for_batching", newHash, blocks }
		} catch (error) {
			return { path: filePath, status: "local_error", activity: "parse", error: error as Error }
		}
	}

	private async getSkipReason(filePath: string): Promise<string | typeof SOURCE_MISSING | undefined> {
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

		const fileStat = await readSource(dependencies.fileSystem.stat(Uri.file(filePath)))
		if (fileStat === SOURCE_MISSING) return SOURCE_MISSING
		if (fileStat.size > MAX_FILE_SIZE_BYTES) {
			return "File is too large"
		}
		return undefined
	}

	private skippedResult(filePath: string, reason: string): FileProcessingResult {
		return { path: filePath, status: "skipped", reason }
	}
}
