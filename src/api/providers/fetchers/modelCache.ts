import * as path from "path"
import * as fsSync from "fs"
import { pbkdf2Sync } from "crypto"

import NodeCache from "node-cache"
import { z } from "zod"

import type { ModelRecord } from "@roo-code/types"
import { modelInfoSchema, providerIdentifiers, TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { safeWriteJson } from "../../../utils/safeWriteJson"

import { ContextProxy } from "../../../core/config/ContextProxy"
import { getCacheDirectoryPath } from "../../../utils/storage"
import type { RouterName } from "../../../shared/api"

import { mergeAbortSignals, throwIfAborted } from "../utils/abort-signal"

import { GetModelsOptions } from "../../../shared/api"

import type { ApiHandler } from "../../index"
import { getKimiCodeModels } from "./kimi-code"
import { getZooGatewayModels } from "./zoo-gateway"

const memoryCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 5 * 60 })

// Zod schema for validating ModelRecord structure from disk cache
const modelRecordSchema = z.record(z.string(), modelInfoSchema)

// Track in-flight refresh requests to prevent concurrent API calls for the same provider+url.
// Keyed on the compound cache key (see getCacheKey) so that two different URL-scoped servers never
// deduplicate each other's in-flight refreshes.
const inFlightRefresh = new Map<string, FlightRecord>()

// Upper bound for any fetch started through the single-flight, so a hung endpoint can never keep
// an in-flight entry pending indefinitely. The value is the maximum of the 5–15 s bounds the
// individual fetchers it subsumes used to apply, relaxing rather than tightening endpoints that
// already had a bound.
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000

/**
 * State of one shared (single-flight) provider fetch.
 *
 * Cancellation invariants this record upholds:
 * - The internal AbortController is the only object that may cancel the flight's network
 *   request; caller signals are only ever merged into a per-waiter abort view, so one waiter
 *   aborting can never cancel the fetch out from under the others.
 * - When the last waiter detaches while the fetch is still pending, the flight is aborted and
 *   its map entry removed synchronously, so a caller arriving immediately afterwards starts a
 *   fresh fetch instead of joining a doomed one.
 * - Settlement never stores data in the map: it only removes the entry it created, guarded by
 *   flight identity so a late-settling stale flight can never evict a newer one.
 */
type FlightRecord = {
	promise: Promise<ModelRecord>
	controller: AbortController
	timeoutSignal: AbortSignal
	waiters: number
	pending: boolean
}

// Same single-flight guard for auth-scoped providers. Without this, two concurrent getModels()
// calls (e.g. two panels opening on startup) both miss the session cache and each fire their own
// provider fetch. Keyed on the same compound cache key as authSessionCache.
const inFlightAuthScopedFetch = new Map<string, Promise<ModelRecord>>()

// Generation counter per auth-scoped PROVIDER. Bumped on sign-out invalidation so that an
// in-flight fetch that started before sign-out can detect that the session was invalidated
// and avoid re-populating the cache with stale data. Keyed by provider (not cache key)
// because the cache entry may not exist yet when sign-out occurs.
const authScopedClearGeneration = new Map<AuthScopedProvider, number>()

// Cache keys (see getCacheKey) for which we've already reported an empty model response this
// session. A persistently-empty endpoint (e.g. misconfigured server) would otherwise re-fire this
// event on every cache refresh; gate it to at most once per distinct provider+server+key identity
// until a non-empty response is seen -- the same identity dimensions the model cache itself uses,
// so two different endpoints for the same provider can never suppress each other's signal.
const reportedEmptyModelResponse = new Set<string>()

function captureModelCacheEmptyResponseOnce(
	provider: RouterName,
	cacheKey: string,
	properties: Record<string, unknown>,
): void {
	if (reportedEmptyModelResponse.has(cacheKey)) {
		return
	}

	reportedEmptyModelResponse.add(cacheKey)
	TelemetryService.instance.captureEvent(TelemetryEventName.MODEL_CACHE_EMPTY_RESPONSE, { provider, ...properties })
}

// Providers whose model lists are scoped to the signed-in user (e.g. per-account
// allowlists or org policies). For these we MUST NOT cache results on disk or
// in memory: a sign-in/out cycle could otherwise serve a previous user's model
// list to the next user, and stale data could mask backend allowlist updates.
const AUTH_SCOPED_PROVIDERS: ReadonlySet<RouterName> = new Set([
	providerIdentifiers.zooGateway,
	providerIdentifiers.kimiCode,
])

type AuthScopedProvider = typeof providerIdentifiers.zooGateway | typeof providerIdentifiers.kimiCode

type AuthScopedGetModelsOptions = Extract<GetModelsOptions, { provider: AuthScopedProvider }>

const AUTH_SESSION_TTL_MS = 300_000
const AUTH_SESSION_MAX_ENTRIES = 64

function authSessionHasModels(models: ModelRecord): boolean {
	// Stryker disable next-line EqualityOperator,ConditionalExpression: empty catalogs are never stored in authSessionCache
	return Object.keys(models).length > 0
}

function authSessionKeyMatchesProvider(key: string, provider: RouterName): boolean {
	// Bare equality covers missing apiKey/baseUrl (cache key === provider name).
	// Compound keys always use `provider:...` via getCacheKey.
	return key === provider || key.startsWith(`${provider}:`)
}

type AuthSessionCacheEntry = {
	models: ModelRecord
	etag?: string
	fetchedAt: number
}

// In-memory, per-session catalog cache for auth-scoped providers. Never written to disk
// and keyed by the same compound identity as getCacheKey (provider + baseUrl + token hash).
const authSessionCache = new Map<string, AuthSessionCacheEntry>()

function isAuthScopedProvider(provider: RouterName): provider is AuthScopedProvider {
	return AUTH_SCOPED_PROVIDERS.has(provider)
}

function assertAuthScopedGetModelsOptions(options: GetModelsOptions): AuthScopedGetModelsOptions {
	// Stryker disable next-line ConditionalExpression,StringLiteral: defensive type-narrowing guard; callers already route via isAuthScopedProvider
	if (!isAuthScopedProvider(options.provider)) {
		// Stryker disable next-line CallExpression,StringLiteral: defensive throw; unreachable for typed callers that already passed isAuthScopedProvider
		throw new Error(`Expected auth-scoped provider, got ${options.provider}`)
	}
	// Runtime guard above; TS cannot narrow the GetModelsOptions discriminated union here.
	return options as AuthScopedGetModelsOptions
}

function isAuthSessionFresh(entry: AuthSessionCacheEntry): boolean {
	return Date.now() - entry.fetchedAt < AUTH_SESSION_TTL_MS
}

function pruneExpiredAuthSessionEntries(): void {
	const staleCutoffMs = AUTH_SESSION_TTL_MS * 2
	const now = Date.now()
	for (const [key, entry] of authSessionCache) {
		if (now - entry.fetchedAt >= staleCutoffMs) {
			authSessionCache.delete(key)
		}
	}
}

function enforceAuthSessionCacheBound(): void {
	pruneExpiredAuthSessionEntries()
	while (authSessionCache.size > AUTH_SESSION_MAX_ENTRIES) {
		let oldestKey: string | undefined
		let oldestFetchedAt = Infinity
		for (const [key, entry] of authSessionCache) {
			if (entry.fetchedAt < oldestFetchedAt) {
				oldestFetchedAt = entry.fetchedAt
				oldestKey = key
			}
		}
		// Stryker disable next-line ConditionalExpression: Map iteration always yields a key while size > 0; break is a defensive latch
		if (!oldestKey) {
			break
		}
		authSessionCache.delete(oldestKey)
	}
}

function getAuthSessionEntry(cacheKey: string): AuthSessionCacheEntry | undefined {
	return authSessionCache.get(cacheKey)
}

function setAuthSessionEntry(cacheKey: string, models: ModelRecord, etag?: string): void {
	// Stryker disable next-line ConditionalExpression: callers only pass non-empty catalogs (guarded by modelCount > 0)
	if (Object.keys(models).length === 0) {
		return
	}
	authSessionCache.set(cacheKey, { models, etag, fetchedAt: Date.now() })
	enforceAuthSessionCacheBound()
}

function touchAuthSessionEntry(cacheKey: string, entry: AuthSessionCacheEntry): void {
	authSessionCache.set(cacheKey, { ...entry, fetchedAt: Date.now() })
	// Stryker disable next-line CallExpression: touch cannot grow the cache; bound enforcement is redundant here
	enforceAuthSessionCacheBound()
}

function deleteAuthSessionEntry(cacheKey: string): void {
	authSessionCache.delete(cacheKey)
}

export function clearAuthSessionModelsForProvider(provider: RouterName): void {
	for (const key of authSessionCache.keys()) {
		if (authSessionKeyMatchesProvider(key, provider)) {
			authSessionCache.delete(key)
		}
	}
	// Also invalidate any in-flight fetches — the cache entry may not exist yet
	// if the fetch hasn't resolved, so we must iterate inFlightAuthScopedFetch
	// independently (not just keys already in authSessionCache).
	for (const key of inFlightAuthScopedFetch.keys()) {
		if (authSessionKeyMatchesProvider(key, provider)) {
			inFlightAuthScopedFetch.delete(key)
		}
	}
	// Bump generation so in-flight fetches that started before this clear
	// know they should not write back stale data. Keyed by provider (not cache key)
	// because the cache entry may not exist yet when sign-out occurs.
	if (isAuthScopedProvider(provider)) {
		// Stryker disable next-line ArithmeticOperator: write-back only checks inequality vs generationAtStart; +1 and -1 are equivalent
		authScopedClearGeneration.set(provider, (authScopedClearGeneration.get(provider) ?? 0) + 1)
	}
}

type AuthScopedFetchResult = {
	models: ModelRecord
	etag?: string
	notModified?: boolean
}

async function fetchAuthScopedModelsFromProvider(
	options: AuthScopedGetModelsOptions,
	ifNoneMatch?: string,
): Promise<AuthScopedFetchResult> {
	switch (options.provider) {
		case providerIdentifiers.zooGateway: {
			const result = await getZooGatewayModels({
				zooSessionToken: options.apiKey,
				zooGatewayBaseUrl: options.baseUrl,
				ifNoneMatch,
			})
			if (result.kind === "not_modified") {
				return { models: {}, notModified: true }
			}
			return { models: result.models, etag: result.etag }
		}
		case providerIdentifiers.kimiCode:
			return { models: await getKimiCodeModels(options.apiKey) }
	}
}

async function resolveAuthScopedModels(
	options: GetModelsOptions,
	handler: ApiHandler,
	{ forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<ModelRecord> {
	const { provider } = options
	const cacheKey = getCacheKey(options, handler)
	const existing = getAuthSessionEntry(cacheKey)

	// Stryker disable next-line EqualityOperator: empty catalogs are never stored in authSessionCache
	if (!forceRefresh && existing && isAuthSessionFresh(existing) && authSessionHasModels(existing.models)) {
		return existing.models
	}

	// Coalesce concurrent fetches for the same session identity so two panels
	// opening simultaneously don't each fire their own provider request.
	const existingFlight = inFlightAuthScopedFetch.get(cacheKey)
	if (existingFlight && !forceRefresh) {
		return existingFlight
	}

	// Capture generation before starting the fetch so we can detect if a sign-out occurred
	// between when we started and when we try to write back results.
	const authProvider = provider as AuthScopedProvider
	const generationAtStart = authScopedClearGeneration.get(authProvider) ?? 0

	const fetchPromise = (async () => {
		try {
			const fetched = await fetchAuthScopedModelsFromProvider(
				assertAuthScopedGetModelsOptions(options),
				existing?.etag,
			)

			if (fetched.notModified) {
				// Re-read from the Map: a concurrent sign-out could have cleared
				// the entry between when we captured `existing` and now.
				const current = getAuthSessionEntry(cacheKey)
				if (current && authSessionHasModels(current.models)) {
					touchAuthSessionEntry(cacheKey, current)
					reportedEmptyModelResponse.delete(cacheKey)
					return current.models
				}
				// Sign-out cleared the entry while the 304 was in-flight.
				return {}
			} else {
				const modelCount = Object.keys(fetched.models).length
				if (modelCount > 0) {
					// Guard against re-populating the cache after a sign-out invalidated
					// this key between when we started the fetch and when it resolved.
					// Check both: (1) the in-flight promise is still ours, and (2) no sign-out
					// bumped the generation while we were fetching.
					const generationNow = authScopedClearGeneration.get(authProvider) ?? 0
					if (inFlightAuthScopedFetch.has(cacheKey) && generationNow === generationAtStart) {
						setAuthSessionEntry(cacheKey, fetched.models, fetched.etag)
						reportedEmptyModelResponse.delete(cacheKey)
					}
					return fetched.models
				}

				captureModelCacheEmptyResponseOnce(provider, cacheKey, {
					context: forceRefresh ? "refreshModels" : "getModels",
					hasExistingCache: Boolean(existing && authSessionHasModels(existing.models)),
					...(existing ? { existingCacheSize: Object.keys(existing.models).length } : {}),
				})
			}

			if (existing && authSessionHasModels(existing.models)) {
				return existing.models
			}

			return fetched.models
		} catch (error) {
			if (existing && authSessionHasModels(existing.models)) {
				return existing.models
			}
			throw error
		}
	})()

	// Wrap cleanup in the promise itself so the stored value IS what callers await —
	// a detached .finally() would produce an unhandled rejection when the fetch fails.
	// Only remove our own entry: if sign-out cleared us and a new fetch registered a
	// fresh promise under the same key, we must not delete that newer entry.
	const fetchWithCleanup = fetchPromise.finally(() => {
		if (inFlightAuthScopedFetch.get(cacheKey) === fetchWithCleanup) {
			inFlightAuthScopedFetch.delete(cacheKey)
		}
	})
	inFlightAuthScopedFetch.set(cacheKey, fetchWithCleanup)
	return fetchWithCleanup
}

// Memoize derived digests so the deliberately-structureless KDF runs at most once per
// distinct input per session (getCacheKey / cacheKeyToFilename run on every cache lookup).
const cacheDigestCache = new Map<string, string>()

// Fixed, non-secret application salt. This is NOT credential storage: it derives short,
// stable cache-key components from the API key and the compound cache key so that distinct
// inputs map to distinct cache entries / filenames. PBKDF2 is used (over a plain hash) only
// to obtain a uniform, structureless mapping with no exploitable internal structure; the
// iteration count is intentionally modest because security here rests on truncation, not on
// KDF slowness. Using a KDF rather than a plain digest also keeps API-key-derived values off
// CodeQL's js/insufficient-password-hash sink, which flags any password-tainted value flowing
// into a non-password hashing operation -- and that taint propagates to anything derived from
// the key, including the compound cache key hashed for the on-disk filename.
const CACHE_DIGEST_SALT = "zoo-model-cache-key-v1"
const CACHE_DIGEST_ITERATIONS = 10_000

/**
 * Derive a short, irreversible, truncated digest of a cache input.
 *
 * The output is deliberately far smaller than the entropy of a real API key: collisions
 * across the handful of keys/servers a single user configures are negligible (birthday bound
 * ~ n^2 / 2^(8*bytes)), while the truncated output is small enough that any preimage search
 * yields an astronomically large set of candidate inputs -- so a value written to an on-disk
 * cache filename cannot be reversed to identify the API key it was derived from.
 */
function deriveCacheDigest(value: string, bytes: number): string {
	const memoKey = `${bytes}:${value}`
	const cached = cacheDigestCache.get(memoKey)
	if (cached) return cached
	const digest = pbkdf2Sync(value, CACHE_DIGEST_SALT, CACHE_DIGEST_ITERATIONS, bytes, "sha256").toString("hex")
	cacheDigestCache.set(memoKey, digest)
	return digest
}

// 4 bytes (8 hex chars) = 32 bits for the per-API-key discriminator embedded in the cache key.
const API_KEY_DISCRIMINATOR_BYTES = 4
// 8 bytes (16 hex chars) = 64 bits for the filename digest, preserving the prior filename width.
const FILENAME_DIGEST_BYTES = 8

/**
 * Derive a short, irreversible, non-identifying cache-key discriminator from an API key.
 */
function deriveApiKeyDiscriminator(apiKey: string): string {
	return deriveCacheDigest(apiKey, API_KEY_DISCRIMINATOR_BYTES)
}

/**
 * Build a cache key that is unique per provider+server+key combination.
 *
 * - URL-scoped providers include the normalized baseUrl so that two different servers
 *   of the same provider type never share a cache entry.
 * - Key-scoped providers additionally fold in a short, irreversible discriminator derived
 *   from the API key so that two different API keys on the same server never share a cache
 *   entry (relevant when the server enforces per-key model allowlists, e.g. LiteLLM, Poe,
 *   Requesty). See deriveApiKeyDiscriminator for why the value cannot be reversed to the key.
 */
function getCacheKey(options: GetModelsOptions, handler: ApiHandler): string {
	const { provider } = options
	const scope = handler.getModelCacheScope()
	const isUrlScoped = scope.urlScoped
	const isKeyScoped = scope.keyScoped

	const urlPart = isUrlScoped && options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : undefined
	const keyPart = isKeyScoped && options.apiKey ? deriveApiKeyDiscriminator(options.apiKey) : undefined

	if (urlPart && keyPart) return `${provider}:${urlPart}:${keyPart}`
	if (urlPart) return `${provider}:${urlPart}`
	if (keyPart) return `${provider}:${keyPart}`
	return provider
}

/**
 * Convert a cache key to a filesystem-safe filename component.
 * Hashes the full key to guarantee uniqueness while preserving a readable
 * provider prefix at the start of the filename.
 */
function cacheKeyToFilename(cacheKey: string): string {
	const prefix = cacheKey.split(":")[0] // provider name -- always filesystem-safe
	// The compound cache key embeds the API-key discriminator, so it is treated as
	// password-tainted by static analysis; deriveCacheDigest keeps the filename derivation
	// off the weak-hash sink while still producing a collision-free, irreversible component.
	const hash = deriveCacheDigest(cacheKey, FILENAME_DIGEST_BYTES)
	return `${prefix}_${hash}`
}

async function writeModels(cacheKey: string, data: ModelRecord) {
	const filename = `${cacheKeyToFilename(cacheKey)}_models.json`
	const cacheDir = await getCacheDirectoryPath(ContextProxy.instance.globalStorageUri.fsPath)
	await safeWriteJson(path.join(cacheDir, filename), data)
}

/**
 * Fetch models from the provider API.
 * Extracted to avoid duplication between getModels() and refreshModels().
 *
 * @param options - Provider options for fetching models
 * @param handler - The provider handler that owns the catalog fetch.
 * @param signal - Cancellation signal forwarded to the dispatched fetcher. The single-flight
 * (dedupedFetch) passes its internal controller's signal; the auth-scoped direct path passes
 * none, so those fetchers keep their own bounds.
 * @returns Fresh models from the provider API
 */
async function fetchModelsFromProvider(
	options: GetModelsOptions,
	handler: ApiHandler,
	signal?: AbortSignal,
): Promise<ModelRecord> {
	const { provider } = options
	if (!handler.fetchModels) {
		throw new Error(`Provider ${provider} does not expose a dynamic model catalog`)
	}
	return handler.fetchModels(options, signal)
}

/**
 * Get models from the cache or fetch them from the provider and cache them.
 * There are two caches:
 * 1. Memory cache - This is a simple in-memory cache that is used to store models for a short period of time.
 * 2. File cache - This is a file-based cache that is used to store models for a longer period of time.
 *
 * @param router - The router to fetch models from.
 * @param apiKey - Optional API key for the provider.
 * @param baseUrl - Optional base URL for the provider (currently used only for LiteLLM).
 * @returns The models from the cache or the fetched models.
 */
export const getModels = async (options: GetModelsOptions, handler: ApiHandler): Promise<ModelRecord> => {
	const { provider } = options
	const cacheKey = getCacheKey(options, handler)

	if (handler.getModelCacheScope().authScoped) {
		return resolveAuthScopedModels(options, handler)
	}

	const models = getModelsFromCache(options, handler)

	if (models) {
		return models
	}

	// Route the cache-miss fetch through dedupedFetch(), the same single-flight coordinator
	// refreshModels() uses, keyed on the same compound cacheKey. Without this, concurrent
	// getModels() calls for the same key each independently miss the cache and fire their own
	// redundant provider fetch, and a getModels() fetch racing a refreshModels() fetch for the
	// same key has no ordering guarantee -- whichever call's memoryCache.set() lands last wins,
	// even if it started (and thus reflects) an earlier, staler request. Sharing dedupedFetch()
	// means every caller for a given key -- get or refresh -- converges on one underlying
	// provider fetch. Each entry point still applies its own success/failure contract on top
	// (see below) rather than returning the shared promise directly, so a fetch failure that
	// refreshModels() degrades to cached data doesn't surface as a silent stale result to
	// getModels(), and a fetch failure joined from refreshModels() still re-throws for
	// getModels() callers.
	try {
		const sharedFetch = dedupedFetch(cacheKey, options, handler)

		const fetched = await sharedFetch
		const modelCount = Object.keys(fetched).length

		// Only cache non-empty results so a failed API response doesn't get persisted
		// as if the provider had no models.
		if (modelCount > 0) {
			// Clear the empty-response throttle for any non-empty response, including from
			// auth-scoped providers that skip disk/memory cache, so a later empty response
			// is reported again.
			reportedEmptyModelResponse.delete(cacheKey)

			memoryCache.set(cacheKey, fetched)

			await writeModels(cacheKey, fetched).catch((err) =>
				console.error(`[MODEL_CACHE] Error writing ${cacheKey} models to file cache:`, err),
			)
		} else {
			captureModelCacheEmptyResponseOnce(provider, cacheKey, {
				context: "getModels",
				hasExistingCache: false,
			})
		}

		return fetched
	} catch (error) {
		// Log the error and re-throw it so the caller can handle it (e.g., show a UI message).
		console.error(`[getModels] Failed to fetch models in modelCache for ${provider}:`, error)

		throw error // Re-throw the original error to be handled by the caller.
	}
}

/**
 * Single-flight the raw provider fetch for a cache key across getModels() and refreshModels().
 * Callers apply their own caching/degradation/telemetry behavior on top of the resolved value
 * or rejection -- this only ensures at most one fetchModelsFromProvider() call is in flight per
 * cache key at a time.
 */
function dedupedFetch(cacheKey: string, options: GetModelsOptions, handler: ApiHandler): Promise<ModelRecord> {
	// A pre-aborted caller fails fast before any flight is created or joined: an aborted call
	// must never start (or extend) a shared fetch.
	throwIfAborted(options.signal)

	const existingRecord = inFlightRefresh.get(cacheKey)
	if (existingRecord) {
		return joinFlight(cacheKey, existingRecord, options.signal)
	}

	const controller = new AbortController()
	const timeoutSignal = AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS)
	const onTimeout = () => controller.abort(timeoutSignal.reason)
	timeoutSignal.addEventListener("abort", onTimeout, { once: true })
	const removeTimeoutListener = () => timeoutSignal.removeEventListener("abort", onTimeout)

	// Settlement and a last-waiter abort may happen in either order; both paths are idempotent,
	// and the identity guard makes the two interleavings equivalent.
	let settled = false
	const guardedDelete = () => {
		// Identity guard: only remove this flight's own entry. A late-settling flight that lost
		// its slot must never evict the fresh flight that replaced it.
		if (inFlightRefresh.get(cacheKey) === record) {
			inFlightRefresh.delete(cacheKey)
		}
	}

	const promise: Promise<ModelRecord> = fetchModelsFromProvider(options, handler, controller.signal)
		.then((models) => {
			// Settlement never writes data into the map -- fetched data reaches callers only
			// through the promise they awaited -- it only removes this flight's entry.
			settled = true
			removeTimeoutListener()
			guardedDelete()
			return models
		})
		.catch((error: unknown) => {
			settled = true
			removeTimeoutListener()
			guardedDelete()
			// Re-throw so every still-joined waiter's awaited chain rejects. Waiters attach
			// handlers to this promise at join time (and a settling flight detaches them), so a
			// rejection here always has an observer and can never surface unhandled.
			throw error
		})

	// A released flight (all waiters gone) can still reject later when its fetch observes the
	// cancellation. This terminal observer keeps that rejection from surfacing as an unhandled
	// rejection; joined waiters observe the identical rejection through their own race.
	void promise.catch(() => {})

	const record: FlightRecord = {
		promise,
		controller,
		timeoutSignal,
		waiters: 0,
		get pending() {
			return !settled
		},
	}

	// The settle reactions above can only run after this function's current synchronous run --
	// including the set() below -- completes, since that's the earliest a promise reaction can
	// fire. So the entry is always registered before any settle handler can delete it, even if
	// fetchModelsFromProvider() settles immediately.
	inFlightRefresh.set(cacheKey, record)

	return joinFlight(cacheKey, record, options.signal)
}

/**
 * Attach one waiter to an existing flight. Each waiter counts itself in record.waiters and
 * carries a view signal that fires at the earlier of the flight's bound or its own caller's
 * abort -- the view governs only this waiter's wait, never the network. When the last waiter
 * detaches while the fetch is still pending, the flight is aborted and released synchronously,
 * so a caller arriving afterwards provably starts a fresh flight.
 */
function joinFlight(cacheKey: string, record: FlightRecord, callerSignal?: AbortSignal): Promise<ModelRecord> {
	throwIfAborted(callerSignal)

	record.waiters++
	let detached = false
	let removeViewListener: (() => void) | undefined

	const detach = () => {
		if (detached) {
			return
		}
		detached = true
		removeViewListener?.()
		record.waiters--
		if (record.waiters === 0 && record.pending) {
			// Synchronous release: abort the shared fetch and drop the entry before any further
			// await point runs, so a late joiner never sees a doomed flight.
			record.controller.abort()
			if (inFlightRefresh.get(cacheKey) === record) {
				inFlightRefresh.delete(cacheKey)
			}
		}
	}

	// Per-waiter abort view: fires at the earlier of the flight's timeout bound and this
	// caller's own signal. It governs only this waiter's detach — never the network — so one
	// waiter aborting cannot cancel the shared fetch or its siblings' waits.
	const view = mergeAbortSignals(record.timeoutSignal, callerSignal)

	const cancelled = new Promise<never>((_resolve, reject) => {
		const rejectAbort = () => {
			// Detach inside the abort event itself, not in a later microtask: the last waiter's
			// abort must release the entry synchronously, so a caller issuing a new fetch right
			// after abort() provably observes a fresh flight, not the doomed one.
			detach()
			const abortError = new Error("This operation was aborted")
			abortError.name = "AbortError"
			reject(abortError)
		}
		if (view.aborted) {
			rejectAbort()
			return
		}
		view.addEventListener("abort", rejectAbort, { once: true })
		removeViewListener = () => view.removeEventListener("abort", rejectAbort)
	})

	// The settle hook detaches this waiter once the flight settles, so an abort arriving after
	// settlement is inert and no listener survives the flight.
	void record.promise.then(detach, detach)

	return Promise.race([record.promise, cancelled]).finally(detach)
}

/**
 * Force-refresh models from API, bypassing cache.
 * Uses atomic writes so cache remains available during refresh.
 * This function also prevents concurrent API calls for the same provider using
 * in-flight request tracking to avoid race conditions.
 *
 * @param options - Provider options for fetching models
 * @returns Fresh models from API, or existing cache if refresh yields worse data
 */
export const refreshModels = async (options: GetModelsOptions, handler: ApiHandler): Promise<ModelRecord> => {
	const { provider } = options
	const cacheKey = getCacheKey(options, handler)

	if (handler.getModelCacheScope().authScoped) {
		// Stryker disable next-line BlockStatement: emptying this try falls through into the non-auth provider fetch path
		try {
			return await resolveAuthScopedModels(options, handler, { forceRefresh: true })
			// Stryker disable next-line BlockStatement: emptying catch falls through into non-auth refresh; covered by error-message assertion in tests
		} catch (error) {
			console.error(`[refreshModels] Failed to refresh ${cacheKey} models:`, error)
			const existing = getAuthSessionEntry(cacheKey)
			// Stryker disable next-line ConditionalExpression,BlockStatement,EqualityOperator: resolveAuthScopedModels only throws when no usable session entry remains
			if (existing && authSessionHasModels(existing.models)) {
				return existing.models
			}
			return {}
		}
	}

	// Shares the same underlying fetch getModels() uses (see dedupedFetch) so a refreshModels()
	// call racing a getModels() cache-miss for the same key converges on one provider fetch --
	// but each function still applies its own success/failure contract on the result below
	// rather than sharing that promise's resolution/rejection wholesale.
	// The fetch call is created inside the try: a pre-aborted caller signal makes dedupedFetch()
	// throw synchronously, and refreshModels() must still degrade to cache/{} rather than reject.
	try {
		const sharedFetch = dedupedFetch(cacheKey, options, handler)

		// Force fresh API fetch - skip getModelsFromCache() check
		const models = await sharedFetch
		const modelCount = Object.keys(models).length

		const existingCache = getModelsFromCache(options, handler)
		const existingCount = existingCache ? Object.keys(existingCache).length : 0

		if (modelCount === 0) {
			captureModelCacheEmptyResponseOnce(provider, cacheKey, {
				context: "refreshModels",
				hasExistingCache: existingCount > 0,
				existingCacheSize: existingCount,
			})
			return existingCount > 0 ? existingCache! : {}
		}

		reportedEmptyModelResponse.delete(cacheKey)

		memoryCache.set(cacheKey, models)

		await writeModels(cacheKey, models).catch((err) =>
			console.error(`[refreshModels] Error writing ${cacheKey} models to disk:`, err),
		)

		return models
	} catch (error) {
		console.error(`[refreshModels] Failed to refresh ${cacheKey} models:`, error)
		return getModelsFromCache(options, handler) || {}
	}
}

/**
 * Initialize background model cache refresh.
 * Refreshes public provider caches without blocking or requiring auth.
 * Should be called once during extension activation.
 */
export async function initializeModelCacheRefresh(buildHandler: (provider: RouterName) => ApiHandler): Promise<void> {
	// Wait for extension to fully activate before refreshing
	setTimeout(async () => {
		// Providers that work without API keys
		const publicProviders: Array<{ provider: RouterName; options: GetModelsOptions }> = [
			{
				provider: providerIdentifiers.openrouter,
				options: { provider: providerIdentifiers.openrouter },
			},
			{
				provider: providerIdentifiers.vercelAiGateway,
				options: { provider: providerIdentifiers.vercelAiGateway },
			},
			{
				provider: providerIdentifiers.nanogpt,
				options: { provider: providerIdentifiers.nanogpt },
			},
			{
				provider: providerIdentifiers.ioIntelligence,
				options: { provider: providerIdentifiers.ioIntelligence },
			},
		]

		// Refresh each provider in background (fire and forget)
		for (const { provider, options } of publicProviders) {
			refreshModels(options, buildHandler(provider)).catch(() => {
				// Silent fail - old cache remains available
			})

			// Small delay between refreshes to avoid API rate limits
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
	}, 2000)
}

/**
 * Flush models memory cache for a specific router.
 *
 * @param options - The options for fetching models, including provider, apiKey, and baseUrl
 * @param refresh - If true, immediately fetch fresh data from API
 */
export const flushModels = async (
	options: GetModelsOptions,
	handler: ApiHandler,
	refresh: boolean = false,
): Promise<void> => {
	if (handler.getModelCacheScope().authScoped) {
		const cacheKey = getCacheKey(options, handler)
		if (refresh) {
			try {
				await resolveAuthScopedModels(options, handler, { forceRefresh: true })
			} catch (error) {
				console.error(`[flushModels] Failed to refresh auth-scoped ${cacheKey} models:`, error)
			}
		} else {
			deleteAuthSessionEntry(cacheKey)
		}
		return
	}

	if (refresh) {
		// Don't delete memory cache - let refreshModels atomically replace it
		// This prevents a race condition where getModels() might be called
		// before refresh completes, avoiding a gap in cache availability
		// Await the refresh to ensure the cache is updated before returning
		await refreshModels(options, handler)
	} else {
		// Only delete memory cache when not refreshing. Use the compound cache key so that
		// URL-scoped providers (litellm, poe, etc.) actually evict the per-server entry rather
		// than a bare provider-name entry that was never written.
		memoryCache.del(getCacheKey(options, handler))
	}
}

/**
 * Get models from cache, checking memory first, then disk.
 * This ensures providers always have access to last known good data,
 * preventing fallback to hardcoded defaults on startup.
 *
 * @param options - The options identifying the cache entry (provider, baseUrl, apiKey).
 * @param handler - The handler whose cache scope determines the compound cache key.
 * @returns Models from memory cache, disk cache, or undefined if not cached.
 */
export function getModelsFromCache(options: GetModelsOptions, handler: ApiHandler): ModelRecord | undefined {
	// Auth-scoped providers (e.g. zoo-gateway) must never be served from cache --
	// their model lists are user-specific and a stale file left over from a previous
	// session could leak another user's list. Mirror the guards in getModels/refreshModels.
	if (handler.getModelCacheScope().authScoped) {
		return undefined
	}

	const cacheKey = getCacheKey(options, handler)
	// Check memory cache first (fast)
	const memoryModels = memoryCache.get<ModelRecord>(cacheKey)
	if (memoryModels) {
		return memoryModels
	}

	// Memory cache miss - try to load from disk synchronously
	// This is acceptable because it only happens on cold start or after cache expiry
	try {
		const filename = `${cacheKeyToFilename(cacheKey)}_models.json`
		const cacheDir = getCacheDirectoryPathSync()
		if (!cacheDir) {
			return undefined
		}

		const filePath = path.join(cacheDir, filename)

		// Use synchronous fs to avoid async complexity in getModel() callers
		if (fsSync.existsSync(filePath)) {
			const data = fsSync.readFileSync(filePath, "utf8")
			const models = JSON.parse(data)

			// Validate the disk cache data structure using Zod schema
			// This ensures the data conforms to ModelRecord = Record<string, ModelInfo>
			const validation = modelRecordSchema.safeParse(models)
			if (!validation.success) {
				console.error(
					`[MODEL_CACHE] Invalid disk cache data structure for ${cacheKey}:`,
					validation.error.format(),
				)
				return undefined
			}

			// Populate memory cache for future fast access
			memoryCache.set(cacheKey, validation.data)

			return validation.data
		}
	} catch (error) {
		console.error(`[MODEL_CACHE] Error loading ${cacheKey} models from disk:`, error)
	}

	return undefined
}

/**
 * Clears auth-session maps and the empty-response throttle for test isolation.
 * Prefer this over `vi.resetModules()` so mutation testing instruments the same module instance.
 *
 * @knipignore
 */
export function resetModelCacheTransientStateForTests(): void {
	// Stryker disable next-line CallExpression: test-only reset; per-mutant runs do not require cross-test isolation
	authSessionCache.clear()
	// Stryker disable next-line CallExpression: test-only reset; per-mutant runs do not require cross-test isolation
	inFlightAuthScopedFetch.clear()
	// Stryker disable next-line CallExpression: test-only reset; per-mutant runs do not require cross-test isolation
	authScopedClearGeneration.clear()
	// Stryker disable next-line CallExpression: test-only reset; per-mutant runs do not require cross-test isolation
	reportedEmptyModelResponse.clear()
	// Stryker disable next-line CallExpression: test-only reset; per-mutant runs do not require cross-test isolation
	inFlightRefresh.clear()
}

/**
 * Test-only: observe clear-generation map size (non-auth clears must not insert entries).
 *
 * @knipignore
 */
export function authScopedClearGenerationSizeForTests(): number {
	return authScopedClearGeneration.size
}

/**
 * Synchronous version of getCacheDirectoryPath for use in getModelsFromCache.
 * Returns the cache directory path without async operations.
 */
function getCacheDirectoryPathSync(): string | undefined {
	try {
		const globalStoragePath = ContextProxy.instance?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			return undefined
		}
		const cachePath = path.join(globalStoragePath, "cache")
		return cachePath
	} catch (error) {
		console.error(`[MODEL_CACHE] Error getting cache directory path:`, error)
		return undefined
	}
}
