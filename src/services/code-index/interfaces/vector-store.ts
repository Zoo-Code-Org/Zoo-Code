/**
 * Interface for vector database clients
 */
export type PointStruct = {
	id: string
	vector: number[]
	payload: Record<string, any>
}

export interface IVectorStore {
	/**
	 * Initializes the vector store
	 * @returns Whether a new collection was created, including recreation after a dimension change
	 */
	initialize(): Promise<boolean>

	/**
	 * Upserts points into the vector store
	 * @param points Array of points to upsert
	 */
	upsertPoints(points: PointStruct[]): Promise<void>

	/**
	 * Searches for similar vectors
	 * @param queryVector Vector to search for
	 * @param directoryPrefix Optional directory prefix to filter results
	 * @param minScore Optional minimum score threshold
	 * @param maxResults Optional maximum number of results to return
	 * @returns Promise resolving to search results
	 */
	search(
		queryVector: number[],
		directoryPrefix?: string,
		minScore?: number,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]>

	/**
	 * Deletes points by file path
	 * @param filePath Path of the file to delete points for
	 */
	deletePointsByFilePath(filePath: string): Promise<void>

	/**
	 * Deletes points by multiple file paths
	 * @param filePaths Array of file paths to delete points for
	 */
	deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void>

	/**
	 * Clears all points from the collection
	 */
	clearCollection(): Promise<void>

	/**
	 * Deletes the entire collection.
	 */
	deleteCollection(): Promise<void>

	/**
	 * Checks if the collection exists
	 * @returns Promise resolving to boolean indicating if the collection exists
	 */
	collectionExists(): Promise<boolean>

	/**
	 * Checks index readiness using completion metadata (or legacy point count without a marker).
	 * Returns false for incomplete indexes or read errors; not suitable for authorizing cleanup.
	 */
	hasIndexedData(): Promise<boolean>

	/**
	 * Checks for non-metadata points in an initialized collection, regardless of completion status.
	 * Rejects on query failure: unknown contents must not be treated as an empty collection.
	 */
	hasCodePoints(): Promise<boolean>

	/**
	 * Marks the indexing process as complete by storing metadata
	 * Should be called after a successful full workspace scan or incremental scan
	 */
	markIndexingComplete(): Promise<void>

	/**
	 * Marks the indexing process as incomplete by storing metadata
	 * Should be called at the start of indexing to indicate work in progress
	 */
	markIndexingIncomplete(): Promise<void>
}

export interface VectorStoreSearchResult {
	id: string | number
	score: number
	payload?: Payload | null
}

export interface Payload {
	filePath: string
	codeChunk: string
	startLine: number
	endLine: number
	[key: string]: any
}
