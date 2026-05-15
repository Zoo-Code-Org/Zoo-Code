import fs from "fs/promises"
import path from "path"

import type { CliSettings } from "@/types/index.js"
import {
	DEFAULT_PROVIDER,
	LEGACY_ONBOARDING_PROVIDER_CHOICE_ROO,
	LEGACY_PROVIDER_PREFERENCE_ROO,
	OnboardingProviderChoice,
} from "@/types/index.js"
import { safeWriteJson } from "../../../../../src/utils/safeWriteJson.js"

import { getConfigDir } from "./index.js"

type StoredCliSettings = CliSettings & {
	provider?: string
	onboardingProviderChoice?: string
}

async function persistSettings(settingsPath: string, settings: CliSettings): Promise<void> {
	await safeWriteJson(settingsPath, settings, { prettyPrint: true })
	await fs.chmod(settingsPath, 0o600)
}

function migrateLegacySettings(settings: StoredCliSettings): { settings: CliSettings; migrated: boolean } {
	let migrated = false
	const nextSettings: StoredCliSettings = { ...settings }

	if (nextSettings.provider === LEGACY_PROVIDER_PREFERENCE_ROO) {
		nextSettings.provider = DEFAULT_PROVIDER
		migrated = true
	}

	if (nextSettings.onboardingProviderChoice === LEGACY_ONBOARDING_PROVIDER_CHOICE_ROO) {
		nextSettings.onboardingProviderChoice = OnboardingProviderChoice.Byok
		migrated = true
	}

	return { settings: nextSettings as CliSettings, migrated }
}

export function getSettingsPath(): string {
	return path.join(getConfigDir(), "cli-settings.json")
}

export async function loadSettings(): Promise<CliSettings> {
	try {
		const settingsPath = getSettingsPath()
		const data = await fs.readFile(settingsPath, "utf-8")
		const parsed = JSON.parse(data) as StoredCliSettings
		const { settings, migrated } = migrateLegacySettings(parsed)

		if (migrated) {
			console.warn(
				`[CLI] Detected legacy Roo Code Router selections in CLI settings. Migrating them to the default provider (${DEFAULT_PROVIDER}).`,
			)
			await persistSettings(settingsPath, settings)
		}

		return settings
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {}
		}

		throw error
	}
}

export async function saveSettings(settings: Partial<CliSettings>): Promise<void> {
	const existing = await loadSettings()
	const merged = { ...existing, ...settings }

	await persistSettings(getSettingsPath(), merged)
}

export async function resetOnboarding(): Promise<void> {
	await saveSettings({ onboardingProviderChoice: undefined })
}
