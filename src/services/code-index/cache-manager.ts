import * as vscode from "vscode"
import { createHash } from "crypto"
import type { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { codeIndexLog } from "./code-index-log"

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

export class CacheManager implements ICacheManager {
	private readonly cachePath: vscode.Uri
	private fileHashes: Record<string, string> = {}
	private openFiles: Record<string, true> = {}
	private watermark?: number
	private saveTail: Promise<void> = Promise.resolve()
	private readonly debouncedSave
	public loadSucceeded = false
	public loadedAt = 0

	constructor(context: vscode.ExtensionContext, workspacePath: string) {
		this.cachePath = vscode.Uri.joinPath(
			context.globalStorageUri,
			`roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
		)
		this.debouncedSave = debounce(() => {
			void this.saveNow().catch((error: unknown) => codeIndexLog.error("Failed to save cache:", error))
		}, 1500)
	}

	async initialize(): Promise<void> {
		this.fileHashes = {}
		this.openFiles = {}
		this.watermark = undefined
		this.loadSucceeded = false
		try {
			const buffer = await vscode.workspace.fs.readFile(this.cachePath)
			const data: unknown = JSON.parse(Buffer.from(buffer).toString())
			if (!isRecord(data)) throw new Error("Invalid indexing cache")
			if (data.version === 2) {
				if (!isRecord(data.fileHashes) || !isRecord(data.openFiles)) {
					throw new Error("Invalid indexing cache records")
				}
				for (const [filePath, hash] of Object.entries(data.fileHashes)) {
					if (typeof hash !== "string") throw new Error("Invalid indexing hash")
					this.fileHashes[filePath] = hash
				}
				for (const [filePath, open] of Object.entries(data.openFiles)) {
					if (open !== true) throw new Error("Invalid open-file record")
					this.openFiles[filePath] = true
					delete this.fileHashes[filePath]
				}
				if (
					typeof data.generationWatermark === "number" &&
					Number.isSafeInteger(data.generationWatermark) &&
					data.generationWatermark >= 0
				) {
					this.watermark = data.generationWatermark
				}
			} else {
				for (const [filePath, hash] of Object.entries(data)) {
					if (typeof hash !== "string") throw new Error("Invalid legacy indexing cache")
					this.fileHashes[filePath] = hash
				}
			}
			this.loadSucceeded = true
		} catch {
			this.fileHashes = {}
			this.openFiles = {}
			this.watermark = undefined
		}
		this.loadedAt = Date.now()
	}

	get generationWatermark(): number | undefined {
		return this.watermark
	}

	async reserveGenerations(watermark: number): Promise<void> {
		this.watermark = watermark
		await this.saveNow()
	}

	async saveNow(): Promise<void> {
		this.debouncedSave.cancel()
		const data = {
			version: 2,
			fileHashes: { ...this.fileHashes },
			openFiles: { ...this.openFiles },
			generationWatermark: this.watermark,
		}
		// An older debounced snapshot must never overwrite durable invalidation.
		const pending = this.saveTail.catch(() => {}).then(() => safeWriteJson(this.cachePath.fsPath, data))
		this.saveTail = pending
		await pending
	}

	async clearCacheFile(): Promise<void> {
		this.fileHashes = {}
		this.openFiles = {}
		await this.saveNow()
	}

	async invalidateFile(filePath: string): Promise<void> {
		delete this.fileHashes[filePath]
		this.openFiles[filePath] = true
		await this.saveNow()
	}

	completeFile(filePath: string, hash: string): void {
		this.fileHashes[filePath] = hash
		delete this.openFiles[filePath]
		this.debouncedSave()
	}

	completeRemoval(filePath: string): void {
		delete this.fileHashes[filePath]
		delete this.openFiles[filePath]
		this.debouncedSave()
	}

	updateHash(filePath: string, hash: string): void {
		this.completeFile(filePath, hash)
	}

	deleteHash(filePath: string): void {
		this.completeRemoval(filePath)
	}

	getOpenFiles(): Record<string, true> {
		return { ...this.openFiles }
	}

	getTrackedPaths(): string[] {
		return [...new Set([...Object.keys(this.fileHashes), ...Object.keys(this.openFiles)])]
	}

	isTracked(filePath: string): boolean {
		return Object.hasOwn(this.fileHashes, filePath) || Object.hasOwn(this.openFiles, filePath)
	}

	getHash(filePath: string): string | undefined {
		return Object.hasOwn(this.fileHashes, filePath) ? this.fileHashes[filePath] : undefined
	}

	async flush(): Promise<void> {
		await this.saveNow()
	}

	getAllHashes(): Record<string, string> {
		return { ...this.fileHashes }
	}
}
