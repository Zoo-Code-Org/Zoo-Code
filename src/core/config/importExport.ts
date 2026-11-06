import { safeWriteJson } from "../../utils/safeWriteJson"
import os from "os"
import * as path from "path"
import fs from "fs/promises"

import * as vscode from "vscode"
import { z, ZodError } from "zod"

import {
	globalSettingsSchema,
	providerSettingsWithIdSchema,
	isProviderName,
	retiredProviderIdentifiers,
	type GlobalSettings,
	type ProviderSettingsWithId,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ProviderSettingsManager, providerProfilesSchema } from "./ProviderSettingsManager"
import { ContextProxy } from "./ContextProxy"
import { CustomModesManager } from "./CustomModesManager"
import { describeFailedWrite, PartialSettingsWriteError, writeValuesThroughWriteChain } from "./appearanceSettingWrites"
import { downgradeLegacyRooConfig, ROUTER_REMOVAL_IMPORT_WARNING } from "./routerRemoval"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { t } from "../../i18n"

export type ImportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
	customModesManager: CustomModesManager
	/**
	 * Called when a setting write that timed out has settled and its rollback has run, so the caller can show what is
	 * really stored (the import has been answered by then).
	 */
	onDeferredSettled?: () => void
	/** Who is importing (the provider): disposing it detaches `onDeferredSettled` and refuses its writes. */
	owner?: object
}

type ExportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
}
type ImportWithProviderOptions = ImportOptions & {
	provider: {
		settingsImportedAt?: number
		settingsImportRefreshedAt?: number
		settingsImportStoredKeys?: string[]
		settingsImportRefreshIsLate?: boolean
		postStateToWebview: () => Promise<void>
	}
}

/** An import that failed after it had started to change settings. */
type PartialImportFailure = {
	success: false
	error: string
	settingsMayHaveChanged: true
	/** The settings the import stored, and those it may have stored (a rollback that did not work). */
	storedSettings?: string[]
}

const isPartialImportFailure = (result: object): result is PartialImportFailure =>
	"settingsMayHaveChanged" in result && result.settingsMayHaveChanged === true

let lastRefreshStamp = 0

/**
 * Shows the webview what is stored, and tells the settings form to take it for `storedSettings`, and for whatever else
 * changed with the state, keeping every other value, with the edits made to it (unlike after an import that succeeded,
 * which replaces the form). The mark is on this one state only. A `late` refresh follows a rollback that finished after
 * the import was answered: the form then keeps an edit that was made since. A refresh that fails does not matter to anybody.
 */
async function refreshWebviewAfterPartialImport(
	provider: ImportWithProviderOptions["provider"],
	storedSettings: string[],
	late = false,
) {
	// Distinct from the stamp of an earlier refresh, so the form never takes two of them for one.
	provider.settingsImportRefreshedAt = lastRefreshStamp = Math.max(Date.now(), lastRefreshStamp + 1)
	provider.settingsImportStoredKeys = storedSettings
	provider.settingsImportRefreshIsLate = late || undefined
	try {
		await provider.postStateToWebview()
	} catch {
		// Nobody is waiting for the refresh.
	} finally {
		provider.settingsImportRefreshedAt = undefined
		provider.settingsImportStoredKeys = undefined
		provider.settingsImportRefreshIsLate = undefined
	}
}

/**
 * Sanitizes a provider config by resetting invalid/removed apiProvider values.
 * Returns the sanitized config and a warning message if the provider was invalid.
 */
function sanitizeProviderConfig(configName: string, apiConfig: unknown): { config: unknown; warning?: string } {
	if (typeof apiConfig !== "object" || apiConfig === null) {
		return { config: apiConfig }
	}

	const { config, migrated } = downgradeLegacyRooConfig(apiConfig as Record<string, unknown>)

	if (migrated) {
		return {
			config,
			warning: `Profile "${configName}": ${ROUTER_REMOVAL_IMPORT_WARNING}`,
		}
	}

	// Check if apiProvider is set and if it's still valid
	if (config.apiProvider !== undefined && !isProviderName(config.apiProvider)) {
		const invalidProvider = config.apiProvider
		// Return a new config object without the invalid apiProvider
		const { apiProvider: _apiProvider, ...restConfig } = config
		return {
			config: restConfig,
			warning: `Profile "${configName}": Invalid provider "${invalidProvider}" was removed. Please reconfigure this profile.`,
		}
	}

	return { config: apiConfig }
}

const globalSettingsShape = globalSettingsSchema.shape as Record<keyof GlobalSettings, z.ZodTypeAny>

function formatZodIssues(error: ZodError): string {
	return error.issues.map((issue) => `[${issue.path.join(".") || "value"}]: ${issue.message}`).join(", ")
}

function sanitizeGlobalSettings(rawGlobalSettings: unknown): {
	sanitizedGlobalSettings: GlobalSettings
	warnings: string[]
} {
	const warnings: string[] = []
	const sanitizedGlobalSettings: Record<string, unknown> = {}

	if (typeof rawGlobalSettings === "undefined") {
		return { sanitizedGlobalSettings: sanitizedGlobalSettings as GlobalSettings, warnings }
	}

	if (typeof rawGlobalSettings !== "object" || rawGlobalSettings === null || Array.isArray(rawGlobalSettings)) {
		warnings.push(
			`Setting "globalSettings" was skipped: Expected object, received ${Array.isArray(rawGlobalSettings) ? "array" : typeof rawGlobalSettings}.`,
		)
		return { sanitizedGlobalSettings: sanitizedGlobalSettings as GlobalSettings, warnings }
	}

	for (const [key, rawValue] of Object.entries(rawGlobalSettings)) {
		const path = `globalSettings.${key}`
		const schema = globalSettingsShape[key as keyof GlobalSettings]

		if (!schema) {
			warnings.push(`Setting "${path}" was skipped: Unknown setting.`)
			continue
		}

		let valueToValidate = rawValue

		if (key === "imageGenerationProvider" && rawValue === retiredProviderIdentifiers.roo) {
			warnings.push(`Setting "${path}" used unsupported value "roo" and was cleared during import.`)
			valueToValidate = undefined
		}

		const result = schema.safeParse(valueToValidate)
		if (result.success) {
			sanitizedGlobalSettings[key] = result.data
		} else {
			warnings.push(`Setting "${path}" was skipped: ${formatZodIssues(result.error)}`)
		}
	}

	return { sanitizedGlobalSettings: sanitizedGlobalSettings as GlobalSettings, warnings }
}

/**
 * Imports configuration from a specific file path
 * Shares base functionality for import settings for both the manual
 * and automatic settings importing.
 *
 * Uses lenient parsing to handle invalid/removed providers gracefully:
 * - Invalid apiProvider values are removed (profile is kept but needs reconfiguration)
 * - Completely invalid profiles are skipped
 * - Warnings are returned for any issues encountered
 */
export async function importSettingsFromPath(
	filePath: string,
	{ providerSettingsManager, contextProxy, customModesManager, onDeferredSettled, owner }: ImportOptions,
) {
	// Use a lenient schema that accepts any apiConfigs, then validate each individually
	const lenientProviderProfilesSchema = providerProfilesSchema.extend({
		apiConfigs: z.record(z.string(), z.any()),
	})

	const lenientSchema = z.object({
		providerProfiles: lenientProviderProfilesSchema,
		globalSettings: z.unknown().optional(),
	})

	// Whether the import has started to change anything: a failure before that leaves every setting as it was.
	let settingsMayHaveChanged = false

	try {
		const previousProviderProfiles = await providerSettingsManager.export()

		const rawData = JSON.parse(await fs.readFile(filePath, "utf-8"))
		const { providerProfiles: rawProviderProfiles, globalSettings: rawGlobalSettings } =
			lenientSchema.parse(rawData)

		// Track warnings for profiles that had issues
		const warnings: string[] = []
		const validApiConfigs: Record<string, ProviderSettingsWithId> = {}

		// Process each apiConfig individually with sanitization
		for (const [configName, rawConfig] of Object.entries(rawProviderProfiles.apiConfigs)) {
			// First sanitize to handle invalid apiProvider values
			const { config: sanitizedConfig, warning } = sanitizeProviderConfig(configName, rawConfig)
			if (warning) {
				warnings.push(warning)
			}

			// Then validate the sanitized config
			const result = providerSettingsWithIdSchema.safeParse(sanitizedConfig)
			if (result.success) {
				validApiConfigs[configName] = result.data
			} else {
				// Profile is completely invalid - skip it
				const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
				warnings.push(`Profile "${configName}" was skipped: ${issues}`)
			}
		}

		// If no valid configs were imported and there were issues, report them
		if (Object.keys(validApiConfigs).length === 0 && warnings.length > 0) {
			return {
				success: false,
				error: `No valid profiles could be imported:\n${warnings.join("\n")}`,
			}
		}

		// Determine the currentApiConfigName:
		// 1. If the imported currentApiConfigName exists in validApiConfigs, use it
		// 2. Otherwise, fall back to the first valid imported profile
		// 3. If no valid profiles were imported, keep the previous currentApiConfigName
		let currentApiConfigName = rawProviderProfiles.currentApiConfigName
		const validProfileNames = Object.keys(validApiConfigs)
		if (!validApiConfigs[currentApiConfigName]) {
			if (validProfileNames.length > 0) {
				currentApiConfigName = validProfileNames[0]
				warnings.push(
					`Profile "${rawProviderProfiles.currentApiConfigName}" was not available; defaulting to "${currentApiConfigName}".`,
				)
			} else {
				// No valid imported profiles; keep the existing currentApiConfigName
				currentApiConfigName = previousProviderProfiles.currentApiConfigName
			}
		}

		const providerProfiles = {
			currentApiConfigName,
			apiConfigs: {
				...previousProviderProfiles.apiConfigs,
				...validApiConfigs,
			},
			modeApiConfigs: {
				...previousProviderProfiles.modeApiConfigs,
				...rawProviderProfiles.modeApiConfigs,
			},
		}

		const { sanitizedGlobalSettings, warnings: globalSettingsWarnings } = sanitizeGlobalSettings(rawGlobalSettings)
		warnings.push(...globalSettingsWarnings)

		settingsMayHaveChanged = true
		await Promise.all(
			(sanitizedGlobalSettings.customModes ?? []).map((mode) =>
				customModesManager.updateCustomMode(mode.slug, mode),
			),
		)

		// OpenAI Compatible settings are now correctly stored in codebaseIndexConfig
		// They will be imported automatically with the config - no special handling needed

		await providerSettingsManager.import(providerProfiles)
		const written = await writeValuesThroughWriteChain(contextProxy, sanitizedGlobalSettings, {
			onDeferredSettled,
			owner,
		})
		if (written.failure) throw describeFailedWrite(written)

		// Set the current provider.
		const currentProviderName = providerProfiles.currentApiConfigName
		const currentProvider = providerProfiles.apiConfigs[currentProviderName]
		await contextProxy.setValue("currentApiConfigName", currentProviderName)

		// TODO: It seems like we don't need to have the provider settings in
		// the proxy; we can just use providerSettingsManager as the source of
		// truth.
		if (currentProvider) {
			await contextProxy.setProviderSettings(currentProvider)
		}

		await contextProxy.setValue("listApiConfigMeta", await providerSettingsManager.listConfig())

		return {
			providerProfiles,
			globalSettings: sanitizedGlobalSettings,
			success: true,
			warnings: warnings.length > 0 ? warnings : undefined,
		}
	} catch (e) {
		let error = "Unknown error"

		if (e instanceof ZodError) {
			error = e.issues.map((issue) => `[${issue.path.join(".")}]: ${issue.message}`).join("\n")
			TelemetryService.instance.captureSchemaValidationError({ schemaName: "ImportExport", error: e })
		} else if (e instanceof Error) {
			error = e.message
		}

		// Only said when it is so: a failure before the import changed anything is the plain failure it always was.
		// The settings that were stored are named too, so the form can take them.
		return settingsMayHaveChanged
			? ({
					success: false,
					error,
					settingsMayHaveChanged: true,
					// The settings the import stored, and those it may have stored (a rollback that did not work): the form
					// takes what is really there for all of them.
					...(e instanceof PartialSettingsWriteError && e.stored.length + e.uncertain.length > 0
						? { storedSettings: [...e.stored, ...e.uncertain] }
						: {}),
				} satisfies PartialImportFailure)
			: { success: false as const, error }
	}
}

/**
 * Import settings from a file using a file dialog
 * @param options - Import options containing managers and proxy
 * @returns Promise resolving to import result
 */
export const importSettings = async ({
	providerSettingsManager,
	contextProxy,
	customModesManager,
	onDeferredSettled,
	owner,
}: ImportOptions) => {
	// Use the last export path as a sensible default, falling back to Downloads
	const defaultUri = resolveDefaultSaveUri(contextProxy, "lastSettingsExportPath", "zoo-code-settings.json", {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uris = await vscode.window.showOpenDialog({
		filters: { JSON: ["json"] },
		canSelectMany: false,
		defaultUri,
	})

	if (!uris) {
		return { success: false, error: "User cancelled file selection" }
	}

	return importSettingsFromPath(uris[0].fsPath, {
		providerSettingsManager,
		contextProxy,
		customModesManager,
		onDeferredSettled,
		owner,
	})
}

/**
 * Import settings from a specific file
 *
 * @internal
 * @param options - Import options containing managers and proxy
 * @param fileUri - URI of the file to import from
 * @returns Promise resolving to import result
 */
export const importSettingsFromFile = async (
	{ providerSettingsManager, contextProxy, customModesManager, onDeferredSettled, owner }: ImportOptions,
	fileUri: vscode.Uri,
) => {
	return importSettingsFromPath(fileUri.fsPath, {
		providerSettingsManager,
		contextProxy,
		customModesManager,
		onDeferredSettled,
		owner,
	})
}

export const exportSettings = async ({ providerSettingsManager, contextProxy }: ExportOptions) => {
	const defaultUri = await resolveDefaultSaveUri(contextProxy, "lastSettingsExportPath", "zoo-code-settings.json", {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uri = await vscode.window.showSaveDialog({
		filters: { JSON: ["json"] },
		defaultUri,
	})

	if (!uri) {
		return
	}

	await saveLastExportPath(contextProxy, "lastSettingsExportPath", uri)

	try {
		const providerProfiles = await providerSettingsManager.export()
		const globalSettings = await contextProxy.export()

		// It's okay if there are no global settings, but if there are no
		// provider profile configured then don't export. If we wanted to
		// support this case then the `importSettings` function would need to
		// be updated to handle the case where there are no provider profiles.
		if (typeof providerProfiles === "undefined") {
			return
		}

		// OpenAI Compatible settings are now correctly stored in codebaseIndexConfig
		// No workaround needed - they will be exported automatically with the config

		const dirname = path.dirname(uri.fsPath)
		await fs.mkdir(dirname, { recursive: true })
		await safeWriteJson(uri.fsPath, { providerProfiles, globalSettings })
	} catch (e) {
		console.error("Failed to export settings:", e)
		// Don't re-throw - the UI will handle showing error messages
	}
}

/**
 * Import settings with complete UI feedback and provider state updates
 * @param options - Import options with provider instance
 * @param filePath - Optional file path to import from. If not provided, a file dialog will be shown.
 * @returns Promise that resolves when import is complete
 */
export const importSettingsWithFeedback = async (
	{ providerSettingsManager, contextProxy, customModesManager, provider }: ImportWithProviderOptions,
	filePath?: string,
) => {
	let result

	// A write of the import that timed out may still land and be rolled back after the import has been answered: the
	// webview is shown what is stored then, and the settings form takes it for the settings that import left uncertain
	// (it took the value that failed to be stored when the import was answered, and a later save would store it again),
	// unless the user has edited that setting since.
	let uncertainSettings: string[] = []
	const onDeferredSettled = () => void refreshWebviewAfterPartialImport(provider, uncertainSettings, true)

	if (filePath) {
		// Validate file path and check if file exists
		try {
			// Check if file exists and is readable
			await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK)
			result = await importSettingsFromPath(filePath, {
				providerSettingsManager,
				contextProxy,
				customModesManager,
				onDeferredSettled,
				owner: provider,
			})
		} catch (error) {
			result = {
				success: false,
				error: `Cannot access file at path "${filePath}": ${error instanceof Error ? error.message : "Unknown error"}`,
			}
		}
	} else {
		result = await importSettings({
			providerSettingsManager,
			contextProxy,
			customModesManager,
			onDeferredSettled,
			owner: provider,
		})
	}

	if (result.success) {
		provider.settingsImportedAt = Date.now()
		await provider.postStateToWebview()
		provider.settingsImportedAt = undefined
		const warnings = "warnings" in result ? result.warnings : undefined

		// Show warnings if any profiles had issues but were still imported (with modifications)
		if (warnings && warnings.length > 0) {
			// Log full details to the console for debugging
			console.warn("Settings import completed with warnings:", warnings)

			// Show a short summary in the toast notification
			const count = warnings.length
			const summary =
				count === 1 ? `1 item had issues during import.` : `${count} items had issues during import.`
			await vscode.window.showWarningMessage(
				`${t("common:info.settings_imported")} ${summary} See Developer Tools console for details.`,
			)
		} else {
			await vscode.window.showInformationMessage(t("common:info.settings_imported"))
		}
	} else if (result.error) {
		// An import that failed part of the way may have stored some of its settings: the webview is shown what is
		// stored, not what it had before, and the settings form takes it without dropping the edits that were made to
		// the other settings (unlike after an import that succeeded). A refresh that fails does not hide the answer.
		// A failure before the import changed anything (a file that cannot be read, a file that is not valid) leaves the
		// settings as they were: nothing is refreshed, so an edit that is newer than the live state is not replaced.
		if (isPartialImportFailure(result)) {
			uncertainSettings = result.storedSettings ?? []
			await refreshWebviewAfterPartialImport(provider, uncertainSettings)
		}
		await vscode.window.showErrorMessage(t("common:errors.settings_import_failed", { error: result.error }))
	}
}
