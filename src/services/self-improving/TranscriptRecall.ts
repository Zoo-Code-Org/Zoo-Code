import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"

/**
 * Transcript entry — a single recorded event or task outcome
 */
export interface TranscriptEntry {
	id: string
	timestamp: number
	taskId?: string
	mode?: string
	summary: string
	signal: string
	workspacePath?: string
	toolNames?: string[]
	errorKey?: string
	success?: boolean
}

/**
 * TranscriptRecall — searchable transcript evidence store.
 */
export class TranscriptRecall {
	private readonly filePath: string
	private readonly logger: Logger
	private entries: TranscriptEntry[] = []
	private initialized = false
	private initializePromise: Promise<void> | null = null

	private static readonly MAX_ENTRIES = 1000

	constructor(baseDir: string, logger: Logger) {
		this.filePath = path.join(baseDir, "self-improving", "transcript-recall.json")
		this.logger = logger
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		if (!this.initializePromise) {
			this.initializePromise = (async () => {
				try {
					await fs.mkdir(path.dirname(this.filePath), { recursive: true })
					await this.loadFromDisk()
				} catch (error) {
					this.logger.appendLine(
						`[TranscriptRecall] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
					)
				} finally {
					this.initialized = true
					this.initializePromise = null
				}
			})()
		}

		await this.initializePromise
	}

	async record(entry: TranscriptEntry): Promise<void> {
		if (!this.initialized) {
			await this.initialize()
		}

		this.entries.push({
			...entry,
			toolNames: entry.toolNames ? [...entry.toolNames] : undefined,
		})

		if (this.entries.length > TranscriptRecall.MAX_ENTRIES) {
			this.entries = this.entries.slice(-TranscriptRecall.MAX_ENTRIES)
		}

		await this.persist()
	}

	search(query: string): TranscriptEntry[] {
		const normalizedQuery = query.toLowerCase()
		return this.entries
			.filter((entry) => {
				if (entry.summary.toLowerCase().includes(normalizedQuery)) {
					return true
				}

				if (entry.signal.toLowerCase().includes(normalizedQuery)) {
					return true
				}

				if (entry.errorKey?.toLowerCase().includes(normalizedQuery)) {
					return true
				}

				if (entry.mode?.toLowerCase().includes(normalizedQuery)) {
					return true
				}

				return entry.toolNames?.some((toolName) => toolName.toLowerCase().includes(normalizedQuery)) ?? false
			})
			.slice(-20)
	}

	searchBySignal(signal: string): TranscriptEntry[] {
		return this.entries.filter((entry) => entry.signal === signal).slice(-50)
	}

	searchByErrorKey(errorKey: string): TranscriptEntry[] {
		return this.entries.filter((entry) => entry.errorKey === errorKey).slice(-20)
	}

	getRecent(count = 10): TranscriptEntry[] {
		return this.entries.slice(-count)
	}

	get size(): number {
		return this.entries.length
	}

	async clear(): Promise<void> {
		this.entries = []
		await this.persist()
	}

	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, "utf-8")
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed)) {
				this.entries = parsed
					.map((entry) => this.sanitizeEntry(entry))
					.filter((entry): entry is TranscriptEntry => entry !== null)
					.slice(-TranscriptRecall.MAX_ENTRIES)
			}
		} catch (error: unknown) {
			const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
			if (errorCode !== "ENOENT") {
				this.logger.appendLine(
					`[TranscriptRecall] Load error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	private sanitizeEntry(value: unknown): TranscriptEntry | null {
		if (!value || typeof value !== "object") {
			return null
		}

		const candidate = value as Partial<TranscriptEntry>
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.timestamp !== "number" ||
			typeof candidate.summary !== "string" ||
			typeof candidate.signal !== "string"
		) {
			return null
		}

		return {
			id: candidate.id,
			timestamp: candidate.timestamp,
			taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
			mode: typeof candidate.mode === "string" ? candidate.mode : undefined,
			summary: candidate.summary,
			signal: candidate.signal,
			workspacePath: typeof candidate.workspacePath === "string" ? candidate.workspacePath : undefined,
			toolNames:
				Array.isArray(candidate.toolNames) &&
				candidate.toolNames.every((toolName) => typeof toolName === "string")
					? [...candidate.toolNames]
					: undefined,
			errorKey: typeof candidate.errorKey === "string" ? candidate.errorKey : undefined,
			success: typeof candidate.success === "boolean" ? candidate.success : undefined,
		}
	}

	private async persist(): Promise<void> {
		try {
			await safeWriteJson(this.filePath, this.entries, { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[TranscriptRecall] Persist error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}
