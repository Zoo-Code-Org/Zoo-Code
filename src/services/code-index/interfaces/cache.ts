export interface ICacheManager {
	getHash(filePath: string): string | undefined
	updateHash(filePath: string, hash: string): void
	deleteHash(filePath: string): void
	flush(): Promise<void>
	getAllHashes(): Record<string, string>
	isTracked(filePath: string): boolean
	getOpenFiles(): Record<string, true>
	getTrackedPaths(): string[]
	invalidateFile(filePath: string): Promise<void>
	completeFile(filePath: string, hash: string): void
	completeRemoval(filePath: string): void
	saveNow(): Promise<void>
	clearCacheFile(): Promise<void>
	readonly loadSucceeded: boolean
	readonly loadedAt: number
	readonly generationWatermark: number | undefined
	reserveGenerations(watermark: number): Promise<void>
}
