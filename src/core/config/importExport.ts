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
import { downgradeLegacyRooConfig, ROUTER_REMOVAL_IMPORT_WARNING } from "./routerRemoval"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { Package } from "../../shared/package"
import { t } from "../../i18n"

export type ImportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
	customModesManager: CustomModesManager
}

type ExportOptions = {
	providerSettingsManager: ProviderSettingsManager
	contextProxy: ContextProxy
}
type ImportWithProviderOptions = ImportOptions & {
	provider: {
		settingsImportedAt?: number
		postStateToWebview: () => Promise<void>
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

		// The schema accepts this key, so without this branch the import reports
		// success and stores a value the enforcement path never reads: the gate is
		// read from VS Code user settings only.
		if (key === "workspaceCommandListsEnabled") {
			warnings.push(
				`Setting "${path}" was skipped: The workspace command-list gate applies only from VS Code user settings, not from an imported file.`,
			)
			continue
		}

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
	{ providerSettingsManager, contextProxy, customModesManager }: ImportOptions,
) {
	// Use a lenient schema that accepts any apiConfigs, then validate each individually
	const lenientProviderProfilesSchema = providerProfilesSchema.extend({
		apiConfigs: z.record(z.string(), z.any()),
	})

	const lenientSchema = z.object({
		providerProfiles: lenientProviderProfilesSchema,
		globalSettings: z.unknown().optional(),
	})

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

		await Promise.all(
			(sanitizedGlobalSettings.customModes ?? []).map((mode) =>
				customModesManager.updateCustomMode(mode.slug, mode),
			),
		)

		// OpenAI Compatible settings are now correctly stored in codebaseIndexConfig
		// They will be imported automatically with the config - no special handling needed

		await providerSettingsManager.import(providerProfiles)
		await contextProxy.setValues(sanitizedGlobalSettings)

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

		return { success: false, error }
	}
}

/**
 * Import settings from a file using a file dialog
 * @param options - Import options containing managers and proxy
 * @returns Promise resolving to import result
 */
export const importSettings = async ({ providerSettingsManager, contextProxy, customModesManager }: ImportOptions) => {
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
	{ providerSettingsManager, contextProxy, customModesManager }: ImportOptions,
	fileUri: vscode.Uri,
) => {
	return importSettingsFromPath(fileUri.fsPath, {
		providerSettingsManager,
		contextProxy,
		customModesManager,
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

/** The open span. `openers` counts the imports still inside the window, so it settles at zero. */
type CommandListSpan = {
	promise: Promise<void>
	settle: () => void
	openers: number
}

/**
 * The command-list span of the imports that have not settled yet.
 *
 * An import writes the lists to extension state and then mirrors them into the
 * user settings file. A save that runs between those two points reads the
 * imported state against the old file, so the save path awaits `promise` before
 * it takes its snapshot. `openers` counts the imports still inside that window:
 * the span covers all of them and settles when the last one releases.
 */
let inFlightCommandListImport: CommandListSpan | undefined

/** Opens a span with one owner and makes it the span a save awaits. */
function openCommandListSpan(): CommandListSpan {
	let settle!: () => void
	const promise = new Promise<void>((resolve) => {
		settle = resolve
	})
	const span: CommandListSpan = { promise, settle, openers: 1 }
	inFlightCommandListImport = span
	return span
}

/** Builds the release handle one opener holds, so no release can count for another. */
function releaseOnce(span: CommandListSpan): () => void {
	let released = false

	return () => {
		if (released) {
			return
		}

		released = true
		span.openers -= 1

		if (span.openers > 0) {
			return
		}

		// Cleared before settling, so a save that starts after the last release sees
		// no span in flight rather than waiting for one that already ended.
		inFlightCommandListImport = undefined
		span.settle()
	}
}

/**
 * Opens the command-list span of an import.
 *
 * @returns A release function that settles the span once every opener has called
 * it. Calling it more than once is safe. An import that opens while another is
 * in flight joins the same span and counts as an owner, so the span settles when
 * the last owner releases and a save never waits on a span whose release was
 * discarded.
 */
export function beginCommandListImport(): () => void {
	const joined = inFlightCommandListImport

	if (joined === undefined) {
		return releaseOnce(openCommandListSpan())
	}

	joined.openers += 1
	return releaseOnce(joined)
}

/**
 * Waits for an import's command-list span to settle.
 *
 * Resolves immediately when no import is in flight. The wait is bounded by the
 * import itself: the mirror retries once and then reports, and every caller
 * releases in a `finally`, so a throwing import cannot leave a save waiting.
 */
export async function awaitCommandListImportSettled(): Promise<void> {
	await inFlightCommandListImport?.promise
}

/**
 * Writes one imported command list into the user settings file, retrying a
 * failed write once.
 *
 * @returns `true` when a write succeeded, `false` when both attempts failed.
 */
async function mirrorCommandList(key: "allowedCommands" | "deniedCommands", imported: string[]): Promise<boolean> {
	// Two attempts: a transient failure retries, a persistent one is reported by
	// the caller.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await vscode.workspace
				.getConfiguration(Package.name)
				.update(key, imported, vscode.ConfigurationTarget.Global)
			return true
		} catch (error) {
			console.warn(`Settings import: could not mirror ${key} into the global configuration:`, error)
		}
	}

	return false
}

/**
 * Writes the command lists an import carried into the user settings file.
 *
 * An import stores the lists only in extension state. A later save reads the
 * user settings file and treats an entry that no configuration layer holds as
 * removed there. That save then drops the entry. This write gives the imported
 * entries a layer, so the save keeps them.
 *
 * A key the import did not carry is skipped, so the state copy never becomes
 * the source. A failed write is retried once and then reported to the user
 * with the manual route; the import itself still succeeds. A later save can
 * still drop the entries until they are stored in user settings, which is why
 * the report names that route.
 *
 * @param globalSettings - The global settings an import produced, or `undefined`.
 */
export async function mirrorImportedCommandLists(globalSettings: GlobalSettings | undefined): Promise<void> {
	// The span covers the writes below, so a save cannot read the imported state
	// against a settings file this function has not finished writing. An enclosing
	// import that already opened a span joins it as a second owner, so neither
	// release can settle the span while the other is still writing.
	const releaseCommandListImport = beginCommandListImport()

	try {
		const failedKeys: string[] = []

		for (const key of ["allowedCommands", "deniedCommands"] as const) {
			const imported = globalSettings?.[key]
			if (!Array.isArray(imported)) {
				continue
			}

			if (!(await mirrorCommandList(key, imported))) {
				failedKeys.push(key)
			}
		}

		if (failedKeys.length > 0) {
			// Fire-and-forget: this promise settles only when the user dismisses the
			// warning, and the caller's state post must not wait for a human answer.
			void vscode.window.showWarningMessage(
				`Settings import: the command list(s) ${failedKeys.join(", ")} could not be written to VS Code user settings. ` +
					`Set them in user settings, or import the file again. Until they are stored there, a later save can remove the imported entries.`,
			)
		}
	} finally {
		releaseCommandListImport()
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

	// The span starts before the import, because the command-list state write
	// happens inside it, and the mirror joins the same span. The notifications
	// below stay outside it: their promises settle only on dismissal.
	const releaseCommandListImport = beginCommandListImport()

	try {
		if (filePath) {
			// Validate file path and check if file exists
			try {
				// Check if file exists and is readable
				await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK)
				result = await importSettingsFromPath(filePath, {
					providerSettingsManager,
					contextProxy,
					customModesManager,
				})
			} catch (error) {
				result = {
					success: false,
					error: `Cannot access file at path "${filePath}": ${error instanceof Error ? error.message : "Unknown error"}`,
				}
			}
		} else {
			result = await importSettings({ providerSettingsManager, contextProxy, customModesManager })
		}

		if (result.success) {
			await mirrorImportedCommandLists(result.globalSettings)
		}
	} finally {
		releaseCommandListImport()
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
		await vscode.window.showErrorMessage(t("common:errors.settings_import_failed", { error: result.error }))
	}
}
