import * as vscode from "vscode"
import { ZodError } from "zod"

import {
	PROVIDER_SETTINGS_KEYS,
	GLOBAL_SETTINGS_KEYS,
	SECRET_STATE_KEYS,
	GLOBAL_STATE_KEYS,
	GLOBAL_SECRET_KEYS,
	type ProviderSettings,
	type GlobalSettings,
	type SecretState,
	type GlobalState,
	type RooCodeSettings,
	providerSettingsSchema,
	globalSettingsSchema,
	isSecretStateKey,
	isProviderName,
	isRetiredProvider,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { logger } from "../../utils/logging"
import { supportPrompt } from "../../shared/support-prompt"
import { downgradeLegacyRooConfig } from "./routerRemoval"

type GlobalStateKey = keyof GlobalState
type SecretStateKey = keyof SecretState
type RooCodeSettingsKey = keyof RooCodeSettings

const PASS_THROUGH_STATE_KEYS = ["taskHistory"]

/** `ContextProxy.setValues` could not store every key: which ones it stored, which it did not, and the first failure. */
export class SettingsWriteError extends Error {
	constructor(
		readonly committed: string[],
		readonly failed: string[],
		override readonly cause: unknown,
	) {
		super(
			`Could not store ${failed.join(", ")}${committed.length > 0 ? ` (stored: ${committed.join(", ")})` : ""}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		)
		this.name = "SettingsWriteError"
	}
}

/** How long the read-back of a failed secret may take: the write error must reach the caller even if it never settles. */
const SECRET_READBACK_TIMEOUT_MS = 5_000

const withinReadBackDeadline = <T>(read: PromiseLike<T>, key: string): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(new Error(`Reading back ${key} did not finish in ${SECRET_READBACK_TIMEOUT_MS / 1000} seconds`)),
			SECRET_READBACK_TIMEOUT_MS,
		)
		Promise.resolve(read)
			.then(resolve, reject)
			.finally(() => clearTimeout(timer))
	})

export const isPassThroughStateKey = (key: string) => PASS_THROUGH_STATE_KEYS.includes(key)

const globalSettingsExportSchema = globalSettingsSchema.omit({
	taskHistory: true,
	listApiConfigMeta: true,
	currentApiConfigName: true,
	// Per-view selection state is machine-local: it keeps flowing through the
	// normal runtime and pruning paths but must not transfer between settings.
	viewStates: true,
})

export class ContextProxy {
	private readonly originalContext: vscode.ExtensionContext

	private stateCache: GlobalState

	private secretCache: SecretState
	private _isInitialized = false

	constructor(context: vscode.ExtensionContext) {
		this.originalContext = context
		this.stateCache = {}
		this.secretCache = {}
		this._isInitialized = false
	}

	public get isInitialized() {
		return this._isInitialized
	}

	public async initialize() {
		for (const key of GLOBAL_STATE_KEYS) {
			try {
				// Revert to original assignment
				this.stateCache[key] = this.originalContext.globalState.get(key)
			} catch (error) {
				logger.error(`Error loading global ${key}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const promises = [
			...SECRET_STATE_KEYS.map(async (key) => {
				try {
					this.secretCache[key] = await this.originalContext.secrets.get(key)
				} catch (error) {
					logger.error(
						`Error loading secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
			...GLOBAL_SECRET_KEYS.map(async (key) => {
				try {
					this.secretCache[key] = await this.originalContext.secrets.get(key)
				} catch (error) {
					logger.error(
						`Error loading global secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
		]

		await Promise.all(promises)

		// Migration: Check for old nested image generation settings and migrate them
		await this.migrateImageGenerationSettings()

		// Migration: Downgrade legacy Roo Code Router state before generic sanitization.
		await this.migrateLegacyRooApiProvider()

		// Migration: Sanitize invalid/removed API providers
		await this.migrateInvalidApiProvider()

		// Migration: Move legacy customCondensingPrompt to customSupportPrompts
		await this.migrateLegacyCondensingPrompt()

		// Migration: Clear old default condensing prompt so users get the improved v2 default
		await this.migrateOldDefaultCondensingPrompt()

		this._isInitialized = true
	}

	/**
	 * Migrates the legacy customCondensingPrompt to the new customSupportPrompts structure
	 * and removes the legacy field.
	 *
	 * Note: Only true customizations are migrated. If the legacy prompt equals the default,
	 * we skip the migration to avoid pinning users to an old default if the default changes.
	 */
	private async migrateLegacyCondensingPrompt() {
		try {
			const legacyPrompt = this.originalContext.globalState.get<string>("customCondensingPrompt")
			if (legacyPrompt) {
				const currentSupportPrompts =
					this.originalContext.globalState.get<Record<string, string>>("customSupportPrompts") || {}

				// Only migrate if:
				// 1. The new location doesn't already have a value
				// 2. The legacy prompt is a true customization (not equal to the default)
				// This prevents pinning users to an old default if the default prompt changes.
				const isCustomized = legacyPrompt.trim() !== supportPrompt.default.CONDENSE.trim()
				if (!currentSupportPrompts.CONDENSE && isCustomized) {
					logger.info("Migrating customized legacy customCondensingPrompt to customSupportPrompts")
					const updatedPrompts = { ...currentSupportPrompts, CONDENSE: legacyPrompt }
					await this.originalContext.globalState.update("customSupportPrompts", updatedPrompts)
					this.stateCache.customSupportPrompts = updatedPrompts
				} else if (!isCustomized) {
					logger.info("Skipping migration: legacy customCondensingPrompt equals the default prompt")
				}

				// Always remove the legacy field
				await this.originalContext.globalState.update("customCondensingPrompt", undefined)
				this.stateCache.customCondensingPrompt = undefined
			}
		} catch (error) {
			logger.error(
				`Error during customCondensingPrompt migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Clears the old v1 default condensing prompt from customSupportPrompts.CONDENSE if present.
	 *
	 * Before PR #10873 "Intelligent Context Condensation v2", the default condensing prompt was
	 * a simpler 6-section format. Users who had this old default saved in their settings would
	 * be stuck with it instead of getting the improved v2 default (which includes analysis tags,
	 * error tracking, all user messages, and better task continuity).
	 *
	 * This migration uses fingerprinting to detect the old v1 default - checking for key
	 * identifying phrases unique to v1 and absence of v2-specific features. This is more
	 * lenient than exact matching and handles whitespace variations.
	 */
	private async migrateOldDefaultCondensingPrompt() {
		try {
			const currentSupportPrompts =
				this.originalContext.globalState.get<Record<string, string>>("customSupportPrompts") || {}

			const savedCondensePrompt = currentSupportPrompts.CONDENSE

			if (savedCondensePrompt && this.isOldV1DefaultCondensePrompt(savedCondensePrompt)) {
				logger.info(
					"Clearing old v1 default condensing prompt from customSupportPrompts.CONDENSE - user will now get the improved v2 default",
				)

				// Remove the CONDENSE key from customSupportPrompts
				const { CONDENSE: _, ...remainingPrompts } = currentSupportPrompts
				const updatedPrompts = Object.keys(remainingPrompts).length > 0 ? remainingPrompts : undefined

				await this.originalContext.globalState.update("customSupportPrompts", updatedPrompts)
				this.stateCache.customSupportPrompts = updatedPrompts
			}
		} catch (error) {
			logger.error(
				`Error during old default condensing prompt migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Detects if a prompt is the old v1 default condensing prompt using fingerprinting.
	 * This is more lenient than exact matching - it checks for key identifying phrases
	 * unique to v1 and absence of v2-specific features.
	 *
	 * V1 characteristics:
	 * - Exactly 6 numbered sections (1-6)
	 * - Contains specific section headers like "Previous Conversation", "Current Work", etc.
	 * - Does NOT contain v2-specific features like "<analysis>", "SYSTEM OPERATION", etc.
	 */
	private isOldV1DefaultCondensePrompt(prompt: string): boolean {
		// Key phrases unique to the v1 default (must ALL be present)
		const v1RequiredPhrases = [
			"Your task is to create a detailed summary of the conversation so far",
			"1. Previous Conversation:",
			"2. Current Work:",
			"3. Key Technical Concepts:",
			"4. Relevant Files and Code:",
			"5. Problem Solving:",
			"6. Pending Tasks and Next Steps:",
			"Output only the summary of the conversation so far",
		]

		// V2-specific features (if ANY are present, this is NOT v1 default)
		const v2Features = [
			"<analysis>",
			"SYSTEM OPERATION",
			"Errors and fixes",
			"All user messages",
			"7.", // v2 has more than 6 sections
			"8.",
			"9.",
		]

		// Check that all v1 required phrases are present
		const hasAllV1Phrases = v1RequiredPhrases.every((phrase) => prompt.toLowerCase().includes(phrase.toLowerCase()))

		// Check that no v2 features are present
		const hasNoV2Features = v2Features.every((feature) => !prompt.toLowerCase().includes(feature.toLowerCase()))

		return hasAllV1Phrases && hasNoV2Features
	}

	/**
	 * Migrates legacy Roo Code Router selections into a setup-needed state.
	 */
	private async migrateLegacyRooApiProvider() {
		try {
			const { config: migratedState, migrated } = downgradeLegacyRooConfig(
				this.stateCache as Record<string, unknown>,
			)

			if (!migrated) {
				return
			}

			logger.info("[ContextProxy] Migrating legacy Roo Code Router state to setup-needed fallback")
			this.stateCache = migratedState as GlobalState
			await Promise.all([
				this.originalContext.globalState.update("apiProvider", undefined),
				this.originalContext.globalState.update("apiModelId", undefined),
				this.originalContext.globalState.update("rooApiKey", undefined),
			])
		} catch (error) {
			logger.error(
				`Error during Roo Code Router migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Migrates unknown apiProvider values by clearing them from storage.
	 * Retired providers are preserved so users can keep historical configuration.
	 */
	private async migrateInvalidApiProvider() {
		try {
			const apiProvider = this.stateCache.apiProvider
			const isKnownProvider =
				typeof apiProvider === "string" && (isProviderName(apiProvider) || isRetiredProvider(apiProvider))

			if (apiProvider !== undefined && !isKnownProvider) {
				logger.info(`[ContextProxy] Found invalid provider "${apiProvider}" in storage - clearing it`)
				// Clear the invalid provider from both cache and storage
				this.stateCache.apiProvider = undefined
				await this.originalContext.globalState.update("apiProvider", undefined)
			}
		} catch (error) {
			logger.error(
				`Error during invalid API provider migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Migrates old nested openRouterImageGenerationSettings to the new flattened structure
	 */
	private async migrateImageGenerationSettings() {
		try {
			// Check if there's an old nested structure
			const oldNestedSettings = this.originalContext.globalState.get<any>("openRouterImageGenerationSettings")

			if (oldNestedSettings && typeof oldNestedSettings === "object") {
				logger.info("Migrating old nested image generation settings to flattened structure")

				// Migrate the API key if it exists and we don't already have one
				if (oldNestedSettings.openRouterApiKey && !this.secretCache.openRouterImageApiKey) {
					await this.originalContext.secrets.store(
						"openRouterImageApiKey",
						oldNestedSettings.openRouterApiKey,
					)
					this.secretCache.openRouterImageApiKey = oldNestedSettings.openRouterApiKey
					logger.info("Migrated openRouterImageApiKey to secrets")
				}

				// Migrate the selected model if it exists and we don't already have one
				if (oldNestedSettings.selectedModel && !this.stateCache.openRouterImageGenerationSelectedModel) {
					await this.originalContext.globalState.update(
						"openRouterImageGenerationSelectedModel",
						oldNestedSettings.selectedModel,
					)
					this.stateCache.openRouterImageGenerationSelectedModel = oldNestedSettings.selectedModel
					logger.info("Migrated openRouterImageGenerationSelectedModel to global state")
				}

				// Clean up the old nested structure
				await this.originalContext.globalState.update("openRouterImageGenerationSettings", undefined)
				logger.info("Removed old nested openRouterImageGenerationSettings")
			}
		} catch (error) {
			logger.error(
				`Error during image generation settings migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	public get extensionUri() {
		return this.originalContext.extensionUri
	}

	public get extensionPath() {
		return this.originalContext.extensionPath
	}

	public get globalStorageUri() {
		return this.originalContext.globalStorageUri
	}

	public get logUri() {
		return this.originalContext.logUri
	}

	public get extension() {
		return this.originalContext.extension
	}

	public get extensionMode() {
		return this.originalContext.extensionMode
	}

	/**
	 * ExtensionContext.globalState
	 * https://code.visualstudio.com/api/references/vscode-api#ExtensionContext.globalState
	 */

	getGlobalState<K extends GlobalStateKey>(key: K): GlobalState[K]
	getGlobalState<K extends GlobalStateKey>(key: K, defaultValue: GlobalState[K]): GlobalState[K]
	getGlobalState<K extends GlobalStateKey>(key: K, defaultValue?: GlobalState[K]): GlobalState[K] {
		if (isPassThroughStateKey(key)) {
			const value = this.originalContext.globalState.get<GlobalState[K]>(key)
			return value === undefined || value === null ? defaultValue : value
		}

		const value = this.stateCache[key]
		return value !== undefined ? value : defaultValue
	}

	/**
	 * The write that last set each cached key, so a failed write only corrects the cache while it is still the latest:
	 * a newer write of the key has its own outcome, and an older failure must not replace its value.
	 */
	private readonly stateWriteOwner = new Map<string, object>()
	private readonly secretWriteOwner = new Map<string, object>()
	/** How many writes of each secret were started. Unlike the owners, it is not cleared when a write is over. */
	private readonly secretWriteCount = new Map<string, number>()

	updateGlobalState<K extends GlobalStateKey>(key: K, value: GlobalState[K]) {
		if (isPassThroughStateKey(key)) {
			return this.originalContext.globalState.update(key, value)
		}

		// The cache is updated first, so a read right after the call sees the value. If the store rejects, the cache is
		// read back from the Memento (`globalState.get`) so that it shows what the Memento holds. This is best effort: a
		// Memento can keep the attempted value in memory after a rejected update, in which case the cache and the
		// Memento agree and only the durable copy, which cannot be read, may differ until the key is written again.
		// The entry of the key is removed when the write is over (if it is still the latest), so the map only holds the
		// writes that are in flight. An update that throws at once is turned into a rejection, so it is handled the same.
		const owner = {}
		this.stateWriteOwner.set(key, owner)
		this.stateCache[key] = value
		const release = () => {
			if (this.stateWriteOwner.get(key) === owner) this.stateWriteOwner.delete(key)
		}
		return (async () => this.originalContext.globalState.update(key, value))().then(release, (error: unknown) => {
			try {
				if (this.stateWriteOwner.get(key) === owner) {
					this.stateCache[key] = this.originalContext.globalState.get<GlobalState[K]>(key)
				}
			} finally {
				release()
			}
			throw error
		})
	}

	private getAllGlobalState(): GlobalState {
		return Object.fromEntries(GLOBAL_STATE_KEYS.map((key) => [key, this.getGlobalState(key)]))
	}

	/**
	 * ExtensionContext.secrets
	 * https://code.visualstudio.com/api/references/vscode-api#ExtensionContext.secrets
	 */

	getSecret(key: SecretStateKey) {
		return this.secretCache[key]
	}

	storeSecret(key: SecretStateKey, value?: string) {
		// Update cache.
		const owner = {}
		this.secretWriteOwner.set(key, owner)
		this.secretWriteCount.set(key, (this.secretWriteCount.get(key) ?? 0) + 1)
		this.secretCache[key] = value

		// Write directly to context. If the write rejects, the cache is read back from the secret storage while this
		// write is still the latest of the key; if that fails too, the value that was never stored is dropped from the
		// cache (it stays empty until the next write, `refreshSecrets` or a restart) rather than being served.
		// The entry of the key is removed when the write and its read-back are over (if it is still the latest). A store
		// that throws at once is turned into a rejection, so it is handled the same.
		const release = () => {
			if (this.secretWriteOwner.get(key) === owner) this.secretWriteOwner.delete(key)
		}
		const stored = (async () =>
			value === undefined
				? this.originalContext.secrets.delete(key)
				: this.originalContext.secrets.store(key, value))()
		return stored.then(release, async (error: unknown) => {
			try {
				if (this.secretWriteOwner.get(key) === owner) {
					try {
						const readBack = await withinReadBackDeadline(this.originalContext.secrets.get(key), key)
						if (this.secretWriteOwner.get(key) === owner) this.secretCache[key] = readBack
					} catch (readError) {
						logger.error(
							`Error reading back secret ${key}: ${readError instanceof Error ? readError.message : String(readError)}`,
						)
						if (this.secretWriteOwner.get(key) === owner) this.secretCache[key] = undefined
					}
				}
			} finally {
				release()
			}
			throw error
		})
	}

	/**
	 * Loads one secret into the cache. A write of the key that started while the secret was being read has its own
	 * outcome, even if it is already over, so the (older) value that was read is dropped. Otherwise the load takes over the key from a write that is
	 * still pending, so that a failure of that write cannot replace what was just loaded.
	 */
	private async refreshSecret(key: SecretStateKey) {
		const writes = this.secretWriteCount.get(key)
		const value = await this.originalContext.secrets.get(key)
		if (this.secretWriteCount.get(key) !== writes) return
		this.secretWriteOwner.delete(key)
		this.secretCache[key] = value
	}

	/**
	 * Refresh secrets from storage and update cache
	 * This is useful when you need to ensure the cache has the latest values
	 */
	async refreshSecrets(): Promise<void> {
		const promises = [
			...SECRET_STATE_KEYS.map(async (key) => {
				try {
					await this.refreshSecret(key)
				} catch (error) {
					logger.error(
						`Error refreshing secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
			...GLOBAL_SECRET_KEYS.map(async (key) => {
				try {
					await this.refreshSecret(key)
				} catch (error) {
					logger.error(
						`Error refreshing global secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
		]
		await Promise.all(promises)
	}

	private getAllSecretState(): SecretState {
		return Object.fromEntries([
			...SECRET_STATE_KEYS.map((key) => [key, this.getSecret(key as SecretStateKey)]),
			...GLOBAL_SECRET_KEYS.map((key) => [key, this.getSecret(key as SecretStateKey)]),
		])
	}

	/**
	 * GlobalSettings
	 */

	public getGlobalSettings(): GlobalSettings {
		const values = this.getValues()

		try {
			return globalSettingsSchema.parse(values)
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "GlobalSettings", error })
			}

			return GLOBAL_SETTINGS_KEYS.reduce((acc, key) => ({ ...acc, [key]: values[key] }), {} as GlobalSettings)
		}
	}

	/**
	 * ProviderSettings
	 */

	public getProviderSettings(): ProviderSettings {
		const values = this.getValues()

		// Sanitize invalid/removed apiProvider values before parsing
		// This handles cases where a user had a provider selected that was later removed
		// from the extension (e.g., "glama"). We sanitize here to avoid repeated
		// schema validation errors that can cause infinite loops in telemetry.
		const sanitizedValues = this.sanitizeProviderValues(values)

		try {
			return providerSettingsSchema.parse(sanitizedValues)
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "ProviderSettings", error })
			}

			return PROVIDER_SETTINGS_KEYS.reduce(
				(acc, key) => ({ ...acc, [key]: sanitizedValues[key] }),
				{} as ProviderSettings,
			)
		}
	}

	/**
	 * Sanitizes provider values by resetting unknown apiProvider values.
	 * Active and retired providers are preserved.
	 */
	private sanitizeProviderValues(values: RooCodeSettings): RooCodeSettings {
		const { config: rooSanitizedValues } = downgradeLegacyRooConfig(values as Record<string, unknown>)
		let sanitizedValues = rooSanitizedValues as RooCodeSettings

		// Remove legacy Claude Code CLI wrapper keys that may still exist in global state.
		// These keys were used by a removed local CLI runner and are no longer part of ProviderSettings.
		const legacyKeys = ["claudeCodePath", "claudeCodeMaxOutputTokens"] as const

		for (const key of legacyKeys) {
			if (key in sanitizedValues) {
				const copy = { ...sanitizedValues } as Record<string, unknown>
				delete copy[key as string]
				sanitizedValues = copy as RooCodeSettings
			}
		}

		const isKnownProvider =
			typeof sanitizedValues.apiProvider === "string" &&
			(isProviderName(sanitizedValues.apiProvider) || isRetiredProvider(sanitizedValues.apiProvider))

		if (sanitizedValues.apiProvider !== undefined && !isKnownProvider) {
			logger.info(
				`[ContextProxy] Sanitizing invalid provider "${sanitizedValues.apiProvider}" - resetting to undefined`,
			)
			// Return a new values object without the invalid apiProvider
			const { apiProvider: _apiProvider, ...restValues } = sanitizedValues
			return restValues as RooCodeSettings
		}
		return sanitizedValues
	}

	public async setProviderSettings(values: ProviderSettings) {
		// Explicitly clear out any old API configuration values before that
		// might not be present in the new configuration.
		// If a value is not present in the new configuration, then it is assumed
		// that the setting's value should be `undefined` and therefore we
		// need to remove it from the state cache if it exists.

		// Ensure openAiHeaders is always an object even when empty
		// This is critical for proper serialization/deserialization through IPC
		if (values.openAiHeaders !== undefined) {
			// Check if it's empty or null
			if (!values.openAiHeaders || Object.keys(values.openAiHeaders).length === 0) {
				values.openAiHeaders = {}
			}
		}

		await this.setValues({
			...PROVIDER_SETTINGS_KEYS.filter((key) => !isSecretStateKey(key))
				.filter((key) => !!this.stateCache[key])
				.reduce((acc, key) => ({ ...acc, [key]: undefined }), {} as ProviderSettings),
			...values,
		})
	}

	/**
	 * RooCodeSettings
	 */

	public async setValue<K extends RooCodeSettingsKey>(key: K, value: RooCodeSettings[K]) {
		return isSecretStateKey(key)
			? this.storeSecret(key as SecretStateKey, value as string)
			: this.updateGlobalState(key as GlobalStateKey, value)
	}

	public getValue<K extends RooCodeSettingsKey>(key: K): RooCodeSettings[K] {
		return isSecretStateKey(key)
			? (this.getSecret(key as SecretStateKey) as RooCodeSettings[K])
			: (this.getGlobalState(key as GlobalStateKey) as RooCodeSettings[K])
	}

	public getValues(): RooCodeSettings {
		const globalState = this.getAllGlobalState()
		const secretState = this.getAllSecretState()

		// Simply merge all states - no nested secrets to handle
		return { ...globalState, ...secretState }
	}

	/**
	 * Writes every value at once. This is not a transaction, for any setting: each key is stored on its own, and the
	 * stores that completed are not undone. If any store rejects, every store is still awaited (the call stays pending
	 * until the last one has settled) and then rejects with a `SettingsWriteError` that says which keys were stored and
	 * which were not. A failed store has already read its key back into the cache (see `updateGlobalState` and
	 * `storeSecret`; best effort for global state, whose Memento may keep the attempted value). Callers that need more than this, such as a
	 * rollback, must provide it themselves.
	 */
	public async setValues(values: RooCodeSettings) {
		const entries = Object.entries(values) as [RooCodeSettingsKey, unknown][]
		const results = await Promise.allSettled(entries.map(([key, value]) => this.setValue(key, value)))

		const committed: string[] = []
		const failed: string[] = []
		let cause: unknown
		let hasCause = false
		for (const [index, [key]] of entries.entries()) {
			const result = results[index]
			if (result.status === "fulfilled") {
				committed.push(key)
				continue
			}
			// The first failure is the cause, even when it was rejected without a reason.
			if (!hasCause) {
				cause = result.reason
				hasCause = true
			}
			failed.push(key)
		}
		if (failed.length > 0) throw new SettingsWriteError(committed, failed, cause)
	}

	/**
	 * Import / Export
	 */

	public async export(): Promise<GlobalSettings | undefined> {
		try {
			const globalSettings = globalSettingsExportSchema.parse(this.getValues())

			// Exports should only contain global settings, so this skips project custom modes (those exist in the .roomode folder)
			globalSettings.customModes = globalSettings.customModes?.filter((mode) => mode.source === "global")

			return Object.fromEntries(Object.entries(globalSettings).filter(([_, value]) => value !== undefined))
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "GlobalSettings", error })
			}

			return undefined
		}
	}

	/**
	 * Resets all global state, secrets, and in-memory caches.
	 * This clears all data from both the in-memory caches and the VSCode storage.
	 * @returns A promise that resolves when all reset operations are complete
	 */
	public async resetAllState() {
		// Clear in-memory caches
		this.stateCache = {}
		this.secretCache = {}
		// A write that started before this reset must not restore its pre-reset value when it
		// rejects afterwards, so advance every generation the pending writes still hold.
		for (const key of this.stateWriteGenerations.keys()) {
			this.stateWriteGenerations.set(key, (this.stateWriteGenerations.get(key) ?? 0) + 1)
		}

		await Promise.all([
			...GLOBAL_STATE_KEYS.map((key) => this.originalContext.globalState.update(key, undefined)),
			...SECRET_STATE_KEYS.map((key) => this.originalContext.secrets.delete(key)),
			...GLOBAL_SECRET_KEYS.map((key) => this.originalContext.secrets.delete(key)),
		])

		await this.initialize()
	}

	private static _instance: ContextProxy | null = null

	static get instance() {
		if (!this._instance) {
			throw new Error("ContextProxy not initialized")
		}

		return this._instance
	}

	static async getInstance(context: vscode.ExtensionContext) {
		if (this._instance) {
			return this._instance
		}

		this._instance = new ContextProxy(context)
		await this._instance.initialize()

		return this._instance
	}
}
