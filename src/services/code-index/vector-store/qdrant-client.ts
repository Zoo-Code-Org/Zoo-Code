import { codeIndexLog } from "../code-index-log"
import { parseRetryAfterMs, VectorStoreError } from "../shared/indexing-errors"
import { makeRateLimitScope } from "../provider-pacer"
import { QdrantClient, QdrantClientResourceExhaustedError, Schemas } from "@qdrant/js-client-rest"
import { createHash } from "crypto"
import * as path from "path"
import { v5 as uuidv5 } from "uuid"
import { IVectorStore } from "../interfaces/vector-store"
import { Payload, VectorStoreSearchResult } from "../interfaces"
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_MIN_SCORE, QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"
import { t } from "../../../i18n"

function normalizeVectorStoreError(error: unknown): VectorStoreError {
	return new VectorStoreError(
		error instanceof Error ? error.message : String(error),
		error,
		error instanceof QdrantClientResourceExhaustedError
			? { classification: "rate-limit", statusCode: 429, retryAfterMs: parseRetryAfterMs(error.retry_after) }
			: undefined,
	)
}

/**
 * Qdrant implementation of the vector store interface
 */
export class QdrantVectorStore implements IVectorStore {
	readonly rateLimitScope: string
	private readonly vectorSize!: number
	private readonly DISTANCE_METRIC = "Cosine"

	private client: QdrantClient
	private readonly collectionName: string
	private readonly qdrantUrl: string = "http://localhost:6333"
	private readonly workspacePath: string

	/**
	 * Creates a new Qdrant vector store
	 * @param workspacePath Path to the workspace
	 * @param url Optional URL to the Qdrant server
	 */
	constructor(workspacePath: string, url: string, vectorSize: number, apiKey?: string) {
		// Parse the URL to determine the appropriate QdrantClient configuration
		const parsedUrl = this.parseQdrantUrl(url)

		// Store the resolved URL for our property
		this.qdrantUrl = parsedUrl
		this.rateLimitScope = makeRateLimitScope("qdrant", parsedUrl)
		this.workspacePath = workspacePath

		try {
			const urlObj = new URL(parsedUrl)

			// Always use host-based configuration with explicit ports to avoid QdrantClient defaults
			let port: number
			let useHttps: boolean

			if (urlObj.port) {
				// Explicit port specified - use it and determine protocol
				port = Number(urlObj.port)
				useHttps = urlObj.protocol === "https:"
			} else {
				// No explicit port - use protocol defaults
				if (urlObj.protocol === "https:") {
					port = 443
					useHttps = true
				} else {
					// http: or other protocols default to port 80
					port = 80
					useHttps = false
				}
			}

			this.client = new QdrantClient({
				host: urlObj.hostname,
				https: useHttps,
				port: port,
				prefix: urlObj.pathname === "/" ? undefined : urlObj.pathname.replace(/\/+$/, ""),
				apiKey,
				headers: {
					"User-Agent": "Zoo-Code",
				},
			})
		} catch {
			// If URL parsing fails, fall back to URL-based config
			// Note: This fallback won't correctly handle prefixes, but it's a last resort for malformed URLs.
			this.client = new QdrantClient({
				url: parsedUrl,
				apiKey,
				headers: {
					"User-Agent": "Zoo-Code",
				},
			})
		}

		// Generate collection name from workspace path
		const hash = createHash("sha256").update(workspacePath).digest("hex")
		this.vectorSize = vectorSize
		this.collectionName = `ws-${hash.substring(0, 16)}`
	}

	/**
	 * Parses and normalizes Qdrant server URLs to handle various input formats
	 * @param url Raw URL input from user
	 * @returns Properly formatted URL for QdrantClient
	 */
	private parseQdrantUrl(url: string | undefined): string {
		// Handle undefined/null/empty cases
		if (!url || url.trim() === "") {
			return "http://localhost:6333"
		}

		const trimmedUrl = url.trim()

		// Check if it starts with a protocol
		if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://") && !trimmedUrl.includes("://")) {
			// No protocol - treat as hostname
			return this.parseHostname(trimmedUrl)
		}

		try {
			// Attempt to parse as complete URL - return as-is, let constructor handle ports
			new URL(trimmedUrl)
			return trimmedUrl
		} catch {
			// Failed to parse as URL - treat as hostname
			return this.parseHostname(trimmedUrl)
		}
	}

	/**
	 * Handles hostname-only inputs
	 * @param hostname Raw hostname input
	 * @returns Properly formatted URL with http:// prefix
	 */
	private parseHostname(hostname: string): string {
		if (hostname.includes(":")) {
			// Has port - add http:// prefix if missing
			return hostname.startsWith("http") ? hostname : `http://${hostname}`
		} else {
			// No port - add http:// prefix without port (let constructor handle port assignment)
			return `http://${hostname}`
		}
	}

	private async getCollectionInfo(): Promise<Schemas["CollectionInfo"] | null> {
		try {
			const collectionInfo = await this.client.getCollection(this.collectionName)
			return collectionInfo
		} catch (error: unknown) {
			if (error instanceof Error) {
				codeIndexLog.warn(
					`[QdrantVectorStore] Warning during getCollectionInfo for "${this.collectionName}". Collection may not exist or another error occurred:`,
					error.message,
				)
			}
			return null
		}
	}

	/**
	 * Initializes the vector store
	 * @returns Promise resolving to boolean indicating if a new collection was created
	 */
	async initialize(): Promise<boolean> {
		let created = false
		try {
			const collectionInfo = await this.getCollectionInfo()

			if (collectionInfo === null) {
				// Collection info not retrieved (assume not found or inaccessible), create it
				await this.client.createCollection(this.collectionName, {
					vectors: {
						size: this.vectorSize,
						distance: this.DISTANCE_METRIC,
						on_disk: true,
					},
					hnsw_config: {
						m: 64,
						ef_construct: 512,
						on_disk: true,
					},
				})
				created = true
			} else {
				// Collection exists, check vector size
				const vectorsConfig = collectionInfo.config?.params?.vectors
				let existingVectorSize: number

				if (typeof vectorsConfig === "number") {
					existingVectorSize = vectorsConfig
				} else if (
					vectorsConfig &&
					typeof vectorsConfig === "object" &&
					"size" in vectorsConfig &&
					typeof vectorsConfig.size === "number"
				) {
					existingVectorSize = vectorsConfig.size
				} else {
					existingVectorSize = 0 // Fallback for unknown configuration
				}

				if (existingVectorSize === this.vectorSize) {
					created = false // Exists and correct
				} else {
					// Exists but wrong vector size, recreate with enhanced error handling
					created = await this._recreateCollectionWithNewDimension(existingVectorSize)
				}
			}

			// Create payload indexes
			await this._createPayloadIndexes()
			return created
		} catch (error: any) {
			const errorMessage = error?.message || error
			codeIndexLog.error(
				`[QdrantVectorStore] Failed to initialize Qdrant collection "${this.collectionName}":`,
				errorMessage,
			)

			// If this is already a vector dimension mismatch error (identified by cause), re-throw it as-is
			if (error instanceof Error && error.cause !== undefined) {
				throw error
			}

			// Otherwise, provide a more user-friendly error message that includes the original error
			throw new Error(
				t("embeddings:vectorStore.qdrantConnectionFailed", { qdrantUrl: this.qdrantUrl, errorMessage }),
			)
		}
	}

	/**
	 * Recreates the collection with a new vector dimension, handling failures gracefully.
	 * @param existingVectorSize The current vector size of the existing collection
	 * @returns Promise resolving to boolean indicating if a new collection was created
	 */
	private async _recreateCollectionWithNewDimension(existingVectorSize: number): Promise<boolean> {
		codeIndexLog.warn(
			`[QdrantVectorStore] Collection ${this.collectionName} exists with vector size ${existingVectorSize}, but expected ${this.vectorSize}. Recreating collection.`,
		)

		let deletionSucceeded = false
		let recreationAttempted = false

		try {
			// Step 1: Attempt to delete the existing collection
			codeIndexLog.info(`[QdrantVectorStore] Deleting existing collection ${this.collectionName}...`)
			await this.client.deleteCollection(this.collectionName)
			deletionSucceeded = true
			codeIndexLog.info(`[QdrantVectorStore] Successfully deleted collection ${this.collectionName}`)

			// Step 2: Wait a brief moment to ensure deletion is processed
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Step 3: Verify the collection is actually deleted
			const verificationInfo = await this.getCollectionInfo()
			if (verificationInfo !== null) {
				throw new Error("Collection still exists after deletion attempt")
			}

			// Step 4: Create the new collection with correct dimensions
			codeIndexLog.info(
				`[QdrantVectorStore] Creating new collection ${this.collectionName} with vector size ${this.vectorSize}...`,
			)
			recreationAttempted = true
			await this.client.createCollection(this.collectionName, {
				vectors: {
					size: this.vectorSize,
					distance: this.DISTANCE_METRIC,
					on_disk: true,
				},
				hnsw_config: {
					m: 64,
					ef_construct: 512,
					on_disk: true,
				},
			})
			codeIndexLog.info(`[QdrantVectorStore] Successfully created new collection ${this.collectionName}`)
			return true
		} catch (recreationError) {
			const errorMessage = recreationError instanceof Error ? recreationError.message : String(recreationError)

			// Provide detailed error context based on what stage failed
			let contextualErrorMessage: string
			if (!deletionSucceeded) {
				contextualErrorMessage = `Failed to delete existing collection with vector size ${existingVectorSize}. ${errorMessage}`
			} else if (!recreationAttempted) {
				contextualErrorMessage = `Deleted existing collection but failed verification step. ${errorMessage}`
			} else {
				contextualErrorMessage = `Deleted existing collection but failed to create new collection with vector size ${this.vectorSize}. ${errorMessage}`
			}

			codeIndexLog.error(
				`[QdrantVectorStore] CRITICAL: Failed to recreate collection ${this.collectionName} for dimension change (${existingVectorSize} -> ${this.vectorSize}). ${contextualErrorMessage}`,
			)

			// Create a comprehensive error message for the user
			const dimensionMismatchError = new Error(
				t("embeddings:vectorStore.vectorDimensionMismatch", {
					errorMessage: contextualErrorMessage,
				}),
			)

			// Preserve the original error context
			dimensionMismatchError.cause = recreationError
			throw dimensionMismatchError
		}
	}

	/**
	 * Creates payload indexes for the collection, handling errors gracefully.
	 */
	private async _createPayloadIndexes(): Promise<void> {
		// Completion verification depends on these indexes; initialization must fail if creation fails.
		await this.client.createPayloadIndex(this.collectionName, {
			field_name: "filePath",
			field_schema: "keyword",
			wait: true,
		})
		await this.client.createPayloadIndex(this.collectionName, {
			field_name: "generation",
			field_schema: "integer",
			wait: true,
		})

		// Create index for the 'type' field to enable metadata filtering
		try {
			await this.client.createPayloadIndex(this.collectionName, {
				field_name: "type",
				field_schema: "keyword",
				wait: true,
			})
		} catch (indexError: any) {
			const errorMessage = (indexError?.message || "").toLowerCase()
			if (!errorMessage.includes("already exists")) {
				codeIndexLog.warn(
					`[QdrantVectorStore] Could not create payload index for type on ${this.collectionName}. Details:`,
					indexError?.message || indexError,
				)
			}
		}

		// Create indexes for pathSegments fields
		for (let segmentIndex = 0; segmentIndex <= 4; segmentIndex++) {
			try {
				await this.client.createPayloadIndex(this.collectionName, {
					field_name: `pathSegments.${segmentIndex}`,
					field_schema: "keyword",
					wait: true,
				})
			} catch (indexError: any) {
				const errorMessage = (indexError?.message || "").toLowerCase()
				if (!errorMessage.includes("already exists")) {
					codeIndexLog.warn(
						`[QdrantVectorStore] Could not create payload index for pathSegments.${segmentIndex} on ${this.collectionName}. Details:`,
						indexError?.message || indexError,
					)
				}
			}
		}
	}

	/**
	 * Upserts points into the vector store
	 * @param points Array of points to upsert
	 */
	async upsertPoints(
		points: Array<{
			id: string
			vector: number[]
			payload: Record<string, any>
		}>,
	): Promise<void> {
		try {
			const processedPoints = points.map((point) => {
				if (point.payload?.filePath) {
					const segments = point.payload.filePath.split(path.sep).filter(Boolean)
					const pathSegments = segments.reduce(
						(acc: Record<string, string>, segment: string, index: number) => {
							acc[index.toString()] = segment
							return acc
						},
						{},
					)
					return {
						...point,
						payload: {
							...point.payload,
							pathSegments,
						},
					}
				}
				return point
			})

			await this.client.upsert(this.collectionName, {
				points: processedPoints,
				wait: true,
			})
		} catch (error) {
			codeIndexLog.error("Failed to upsert points:", error)
			throw normalizeVectorStoreError(error)
		}
	}

	/**
	 * Checks if a payload is valid
	 * @param payload Payload to check
	 * @returns Boolean indicating if the payload is valid
	 */
	private isPayloadValid(payload: Record<string, unknown> | null | undefined): payload is Payload {
		if (!payload) {
			return false
		}
		const validKeys = ["filePath", "codeChunk", "startLine", "endLine"]
		const hasValidKeys = validKeys.every((key) => key in payload)
		return hasValidKeys
	}

	/**
	 * Searches for similar vectors
	 * @param queryVector Vector to search for
	 * @param directoryPrefix Optional directory prefix to filter results
	 * @param minScore Optional minimum score threshold
	 * @param maxResults Optional maximum number of results to return
	 * @returns Promise resolving to search results
	 */
	async search(
		queryVector: number[],
		directoryPrefix?: string,
		minScore?: number,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]> {
		try {
			let filter:
				| {
						must: Array<{ key: string; match: { value: string } }>
						must_not?: Array<{ key: string; match: { value: string } }>
				  }
				| undefined = undefined

			if (directoryPrefix) {
				// Check if the path represents current directory
				const normalizedPrefix = path.posix.normalize(directoryPrefix.replace(/\\/g, "/"))
				// Note: path.posix.normalize("") returns ".", and normalize("./") returns "./"
				if (normalizedPrefix === "." || normalizedPrefix === "./") {
					// Don't create a filter - search entire workspace
					filter = undefined
				} else {
					// Remove leading "./" from paths like "./src" to normalize them
					const cleanedPrefix = path.posix.normalize(
						normalizedPrefix.startsWith("./") ? normalizedPrefix.slice(2) : normalizedPrefix,
					)
					const segments = cleanedPrefix.split("/").filter(Boolean)
					if (segments.length > 0) {
						filter = {
							must: segments.map((segment, index) => ({
								key: `pathSegments.${index}`,
								match: { value: segment },
							})),
						}
					}
				}
			}

			// Always exclude metadata points at query-time to avoid wasting top-k
			const metadataExclusion = {
				must_not: [{ key: "type", match: { value: "metadata" } }],
			}

			const mergedFilter = filter
				? { ...filter, must_not: [...(filter.must_not || []), ...metadataExclusion.must_not] }
				: metadataExclusion

			const searchRequest = {
				query: queryVector,
				filter: mergedFilter,
				score_threshold: minScore ?? DEFAULT_SEARCH_MIN_SCORE,
				limit: maxResults ?? DEFAULT_MAX_SEARCH_RESULTS,
				params: {
					hnsw_ef: 128,
					exact: false,
				},
				with_payload: {
					include: ["filePath", "codeChunk", "startLine", "endLine", "pathSegments"],
				},
			}

			const operationResult = await this.client.query(this.collectionName, searchRequest)
			const filteredPoints = operationResult.points.filter((p) => this.isPayloadValid(p.payload))

			return filteredPoints as VectorStoreSearchResult[]
		} catch (error) {
			codeIndexLog.error("Failed to search points:", error)
			throw error
		}
	}

	private relativeFilePath(filePath: string): string {
		return path.normalize(path.isAbsolute(filePath) ? path.relative(this.workspacePath, filePath) : filePath)
	}

	async deletePointsByFilePath(filePath: string, beforeGeneration: number): Promise<void> {
		return this.deletePointsByMultipleFilePaths([filePath], beforeGeneration)
	}

	async deletePointsByMultipleFilePaths(filePaths: string[], beforeGeneration: number): Promise<void> {
		if (!Number.isSafeInteger(beforeGeneration) || beforeGeneration < 0) {
			throw new Error("A non-negative safe integer generation cutoff is required")
		}
		if (filePaths.length === 0) return

		await this.client
			.delete(this.collectionName, {
				filter: {
					must: [
						{
							key: "filePath",
							match: { any: filePaths.map((filePath) => this.relativeFilePath(filePath)) },
						},
						{
							should: [
								{ key: "generation", range: { lt: beforeGeneration } },
								{ is_empty: { key: "generation" } },
							],
						},
					],
				},
				wait: true,
			})
			.catch((error: unknown) => {
				throw normalizeVectorStoreError(error)
			})
	}

	async countPointsForFile(filePath: string, generation: number): Promise<{ current: number; other: number }> {
		const fileCondition = { key: "filePath", match: { value: this.relativeFilePath(filePath) } }
		const generationCondition = { key: "generation", match: { value: generation } }
		const [current, other] = await Promise.all([
			this.client.count(this.collectionName, {
				filter: { must: [fileCondition, generationCondition] },
				exact: true,
			}),
			this.client.count(this.collectionName, {
				filter: { must: [fileCondition], must_not: [generationCondition] },
				exact: true,
			}),
		]).catch((error: unknown) => {
			throw normalizeVectorStoreError(error)
		})
		return { current: current.count, other: other.count }
	}

	/**
	 * Deletes the entire collection.
	 */
	async deleteCollection(): Promise<void> {
		try {
			// Check if collection exists before attempting deletion to avoid errors
			if (await this.collectionExists()) {
				await this.client.deleteCollection(this.collectionName)
			}
		} catch (error) {
			codeIndexLog.error(`[QdrantVectorStore] Failed to delete collection ${this.collectionName}:`, error)
			throw error // Re-throw to allow calling code to handle it
		}
	}

	/**
	 * Clears all points from the collection
	 */
	async clearCollection(): Promise<void> {
		try {
			await this.client.delete(this.collectionName, {
				filter: {
					must: [],
				},
				wait: true,
			})
		} catch (error) {
			codeIndexLog.error("Failed to clear collection:", error)
			throw error
		}
	}

	/**
	 * Checks if the collection exists
	 * @returns Promise resolving to boolean indicating if the collection exists
	 */
	async collectionExists(): Promise<boolean> {
		const collectionInfo = await this.getCollectionInfo()
		return collectionInfo !== null
	}

	/**
	 * Checks if the collection exists and has indexed points
	 * @returns Promise resolving to boolean indicating if the collection exists and has points
	 */
	async hasIndexedData(): Promise<boolean> {
		try {
			const collectionInfo = await this.getCollectionInfo()
			if (!collectionInfo) {
				return false
			}
			// Check if the collection has any points indexed
			const pointsCount = collectionInfo.points_count ?? 0
			if (pointsCount === 0) {
				return false
			}

			// Check if the indexing completion marker exists
			// Use a deterministic UUID generated from a constant string
			const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)
			const metadataPoints = await this.client.retrieve(this.collectionName, {
				ids: [metadataId],
			})

			// If marker exists, use it to determine completion status
			if (metadataPoints.length > 0) {
				return metadataPoints[0].payload?.indexing_complete === true
			}

			// Backward compatibility: No marker exists (old index or pre-marker version)
			// Fall back to old logic - assume complete if collection has points
			codeIndexLog.info(
				"[QdrantVectorStore] No indexing metadata marker found. Using backward compatibility mode (checking points_count > 0).",
			)
			return pointsCount > 0
		} catch (error) {
			codeIndexLog.warn("[QdrantVectorStore] Failed to check if collection has data:", error)
			return false
		}
	}

	/**
	 * Marks the indexing process as complete by storing metadata
	 * Should be called after a successful full workspace scan or incremental scan
	 */
	async markIndexingComplete(): Promise<void> {
		try {
			// Create a metadata point with a deterministic UUID to mark indexing as complete
			// Use uuidv5 to generate a consistent UUID from a constant string
			const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							indexing_complete: true,
							completed_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			codeIndexLog.info("[QdrantVectorStore] Marked indexing as complete")
		} catch (error) {
			codeIndexLog.error("[QdrantVectorStore] Failed to mark indexing as complete:", error)
			throw error
		}
	}

	/**
	 * Marks the indexing process as incomplete by storing metadata
	 * Should be called at the start of indexing to indicate work in progress
	 */
	async markIndexingIncomplete(): Promise<void> {
		try {
			// Create a metadata point with a deterministic UUID to mark indexing as incomplete
			// Use uuidv5 to generate a consistent UUID from a constant string
			const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							indexing_complete: false,
							started_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			codeIndexLog.info("[QdrantVectorStore] Marked indexing as incomplete (in progress)")
		} catch (error) {
			codeIndexLog.error("[QdrantVectorStore] Failed to mark indexing as incomplete:", error)
			throw error
		}
	}
}
