import * as vscode from "vscode"
import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { t } from "../../i18n"
import { isSourceMissing } from "./shared/indexing-errors"

/** The cache exists but could not be read; treating it as empty would erase the index on the next scan. */
export class CacheReadError extends Error {
	constructor(cause: unknown) {
		super(t("embeddings:orchestrator.cacheReadFailed"), { cause })
		this.name = "CacheReadError"
	}
}

function isHashMap(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((hash) => typeof hash === "string")
	)
}

/**
 * Manages the cache for code indexing
 */
export class CacheManager implements ICacheManager {
	private cachePath: vscode.Uri
	private fileHashes: Record<string, string> = {}
	private _debouncedSaveCache: () => void

	/**
	 * Creates a new cache manager
	 * @param context VS Code extension context
	 * @param workspacePath Path to the workspace
	 */
	constructor(context: vscode.ExtensionContext, workspacePath: string) {
		this.cachePath = vscode.Uri.joinPath(
			context.globalStorageUri,
			`roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
		)
		this._debouncedSaveCache = debounce(async () => {
			await this._performSave()
		}, 1500)
	}

	/**
	 * Initializes the cache manager by loading the cache file
	 */
	async initialize(): Promise<void> {
		let cacheData: Uint8Array
		try {
			cacheData = await vscode.workspace.fs.readFile(this.cachePath)
		} catch (error) {
			if (isSourceMissing(error)) {
				this.fileHashes = {}
				return
			}
			this.captureError(error, "initialize")
			throw new CacheReadError(error)
		}
		try {
			const parsed: unknown = JSON.parse(Buffer.from(cacheData).toString())
			this.fileHashes = isHashMap(parsed) ? parsed : {}
		} catch (error) {
			this.fileHashes = {}
			this.captureError(error, "initialize")
		}
	}

	private captureError(error: unknown, location: string): void {
		TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			location,
		})
	}

	/**
	 * Saves the cache to disk
	 */
	private async _performSave(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, this.fileHashes)
		} catch (error) {
			console.error("Failed to save cache:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_performSave",
			})
		}
	}

	/**
	 * Clears the cache file by writing an empty object to it
	 */
	async clearCacheFile(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, {})
			this.fileHashes = {}
		} catch (error) {
			console.error("Failed to clear cache file:", error, this.cachePath)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearCacheFile",
			})
		}
	}

	/**
	 * Gets the hash for a file path
	 * @param filePath Path to the file
	 * @returns The hash for the file or undefined if not found
	 */
	getHash(filePath: string): string | undefined {
		return this.fileHashes[filePath]
	}

	/**
	 * Updates the hash for a file path
	 * @param filePath Path to the file
	 * @param hash New hash value
	 */
	updateHash(filePath: string, hash: string): void {
		this.fileHashes[filePath] = hash
		this._debouncedSaveCache()
	}

	/**
	 * Deletes the hash for a file path
	 * @param filePath Path to the file
	 */
	deleteHash(filePath: string): void {
		delete this.fileHashes[filePath]
		this._debouncedSaveCache()
	}

	/**
	 * Flushes any pending debounced cache writes to disk immediately.
	 */
	async flush(): Promise<void> {
		await this._performSave()
	}

	/**
	 * Gets a copy of all file hashes
	 * @returns A copy of the file hashes record
	 */
	getAllHashes(): Record<string, string> {
		return { ...this.fileHashes }
	}
}
