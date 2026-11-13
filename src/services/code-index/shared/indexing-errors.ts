import { APIConnectionError, APIUserAbortError } from "openai"
import type { FileFailureActivity } from "../file-failure-registry"

export type TransientClass = "rate-limit" | "server" | "connection"
export type IndexingErrorClassification = TransientClass | "permanent"

type ErrorDetails = {
	classification?: IndexingErrorClassification
	statusCode?: number
	retryAfterMs?: number
}

type ErrorShape = ErrorDetails & {
	name?: string
	code?: string
	type?: string
	error?: { code?: string; type?: string }
	status?: number
	headers?: RetryAfterHeaders
	response?: { status?: number }
	$metadata?: { httpStatusCode?: number }
	cause?: unknown
}

type RetryAfterHeaders = Headers | Record<string, unknown>

// ENOENT: Node fs/promises; FileNotFound: vscode.FileSystemError. Other codes stay read failures.
export function isSourceMissing(error: unknown): boolean {
	const code = (error as ErrorShape | undefined)?.code
	return code === "ENOENT" || code === "FileNotFound"
}

export const SOURCE_MISSING = Symbol("source-missing")

/** Applies missing-source detection only to the file's own stat or read call. */
export async function readSource<T>(read: PromiseLike<T>): Promise<T | typeof SOURCE_MISSING> {
	try {
		return await read
	} catch (error) {
		if (isSourceMissing(error)) return SOURCE_MISSING
		throw error
	}
}

function nonnegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined
	if (typeof value === "string" && !value.trim()) return undefined
	const number = Number(value)
	return Number.isFinite(number) && number >= 0 ? number : undefined
}

// A delay whose resume deadline falls outside the Date range would make toISOString() throw.
function validDelay(delay: number | undefined, now: number): number | undefined {
	return delay !== undefined && Number.isFinite(new Date(now + delay).getTime()) ? delay : undefined
}

export function parseRetryAfterMs(source: unknown, now = Date.now()): number | undefined {
	return validDelay(parseRawRetryAfterMs(source, now), now)
}

function parseRawRetryAfterMs(source: unknown, now: number): number | undefined {
	if (typeof source === "number") {
		const seconds = nonnegativeNumber(source)
		return seconds !== undefined && Number.isFinite(seconds * 1000) ? seconds * 1000 : undefined
	}
	if (!source || typeof source !== "object") return undefined
	const headers = source as RetryAfterHeaders
	let milliseconds: unknown
	let retryAfter: unknown
	if (typeof headers.get === "function") {
		milliseconds = headers.get("retry-after-ms")
		retryAfter = headers.get("retry-after")
	} else {
		for (const [name, value] of Object.entries(source)) {
			if (name.toLowerCase() === "retry-after-ms") milliseconds = value
			if (name.toLowerCase() === "retry-after") retryAfter = value
		}
	}
	const parsedMilliseconds = nonnegativeNumber(milliseconds)
	if (parsedMilliseconds !== undefined) return parsedMilliseconds
	const seconds = nonnegativeNumber(retryAfter)
	if (seconds !== undefined && Number.isFinite(seconds * 1000)) return seconds * 1000
	if (typeof retryAfter !== "string" || !/[a-z]/i.test(retryAfter)) return undefined
	const delay = Date.parse(retryAfter) - now
	return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function errorChain(error: unknown): ErrorShape[] {
	const chain: ErrorShape[] = []
	const visited = new Set<unknown>()
	while (error && typeof error === "object" && !visited.has(error)) {
		visited.add(error)
		chain.push(error as ErrorShape)
		error = (error as ErrorShape).cause
	}
	return chain
}

function numericStatus(error: ErrorShape): number | undefined {
	return [error.status, error.statusCode, error.response?.status, error.$metadata?.httpStatusCode].find(
		(status) => typeof status === "number" && Number.isFinite(status),
	)
}

export function getIndexingErrorStatusCode(error: unknown): number | undefined {
	for (const entry of errorChain(error)) {
		const status = numericStatus(entry)
		if (status !== undefined) return status
	}
	return undefined
}

export function classifyIndexingError(error: unknown, signal?: AbortSignal): IndexingErrorClassification {
	const chain = errorChain(error)
	if (
		signal?.aborted ||
		error instanceof APIUserAbortError ||
		chain[0]?.name === "AbortError" ||
		chain[0]?.name === "APIUserAbortError"
	) {
		return "permanent"
	}
	for (const entry of chain) {
		if (
			entry.classification === "rate-limit" ||
			entry.classification === "server" ||
			entry.classification === "connection" ||
			entry.classification === "permanent"
		) {
			return entry.classification
		}
	}
	if (chain.some((entry) => entry instanceof APIUserAbortError || entry.name === "AbortError")) return "permanent"
	const status = getIndexingErrorStatusCode(error)
	if (status !== undefined) {
		if (status === 429) return isQuotaExhausted(chain) ? "permanent" : "rate-limit"
		return status >= 500 && status < 600 ? "server" : "permanent"
	}
	const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"])
	for (const entry of chain) {
		if (
			(typeof entry.code === "string" &&
				(networkCodes.has(entry.code) ||
					entry.code.startsWith("UND_ERR_") ||
					entry.code.startsWith("ERR_HTTP2_"))) ||
			(entry instanceof TypeError && entry.cause !== undefined) ||
			entry instanceof APIConnectionError ||
			entry.name === "APIConnectionError" ||
			entry.name === "APIConnectionTimeoutError" ||
			entry.name === "TimeoutError" ||
			entry.name === "QdrantClientTimeoutError"
		) {
			return "connection"
		}
	}
	return "permanent"
}

// Only the structured OpenAI-style marker counts: per-minute throttle bodies can also mention "quota".
function isQuotaExhausted(chain: ErrorShape[]): boolean {
	return chain.some((entry) =>
		[entry.code, entry.type, entry.error?.code, entry.error?.type].includes("insufficient_quota"),
	)
}

export function isQuotaError(error: unknown): boolean {
	return getIndexingErrorStatusCode(error) === 429 && isQuotaExhausted(errorChain(error))
}

class IndexingError extends Error {
	readonly classification: IndexingErrorClassification
	readonly statusCode?: number

	readonly retryAfterMs?: number

	constructor(message: string, cause: unknown, details?: ErrorDetails) {
		super(message, { cause })
		this.name = new.target.name
		this.classification = details?.classification ?? classifyIndexingError(cause)
		this.statusCode = details?.statusCode ?? getIndexingErrorStatusCode(cause)
		this.retryAfterMs = details?.retryAfterMs
		if (this.retryAfterMs === undefined) {
			for (const entry of errorChain(cause)) {
				this.retryAfterMs = nonnegativeNumber(entry.retryAfterMs)
				// Indexing-owned causes already checked for valid, missing or invalid headers.
				if (entry instanceof IndexingError) break
				this.retryAfterMs ??= parseRetryAfterMs(entry.headers)
				if (this.retryAfterMs !== undefined) break
			}
		}
	}
}

export class EmbeddingError extends IndexingError {}
export class VectorStoreError extends IndexingError {}
export class SearchProviderRateLimitError extends IndexingError {}

export class IndexingRetryError extends IndexingError {
	constructor(
		cause: unknown,
		readonly attempts: number,
		classification: IndexingErrorClassification,
		readonly activity?: FileFailureActivity,
	) {
		super(cause instanceof Error ? cause.message : String(cause), cause, { classification })
	}
}
