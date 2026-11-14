import { createInstance } from "i18next"

interface WaitMessages {
	providerWaiting: string
	providerWaitingUntil: string
	providerPaused: string
	providerPausedUntil: string
}

interface SettingsMessages {
	codeIndex: WaitMessages
}

interface EmbeddingMessages {
	searchProviderRateLimited: string
	orchestrator: Pick<WaitMessages, "providerWaiting" | "providerWaitingUntil">
}

const settingsLocales = import.meta.glob<SettingsMessages>("../../../i18n/locales/*/settings.json", {
	eager: true,
	import: "default",
})
const embeddingLocales = import.meta.glob<EmbeddingMessages>("../../../../../src/i18n/locales/*/embeddings.json", {
	eager: true,
	import: "default",
})
const locales = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
]

it.each(locales)("provides matching provider-wait and search keys in %s", async (locale) => {
	const settings = settingsLocales[`../../../i18n/locales/${locale}/settings.json`]
	const embeddings = embeddingLocales[`../../../../../src/i18n/locales/${locale}/embeddings.json`]
	expect(settings).toBeDefined()
	expect(embeddings).toBeDefined()
	const translation = createInstance()
	await translation.init({
		lng: locale,
		fallbackLng: false,
		resources: { [locale]: { settings, embeddings } },
		interpolation: { escapeValue: false },
	})
	for (const key of ["providerWaiting", "providerWaitingUntil"] as const) {
		expect(settings.codeIndex[key]).toBe(embeddings.orchestrator[key])
	}
	for (const key of ["providerWaiting", "providerWaitingUntil", "providerPaused", "providerPausedUntil"] as const) {
		const message = settings.codeIndex[key]
		expect(message).toContain("{{service}}")
		expect(message.includes("{{time}}")).toBe(key.endsWith("Until"))
		const rendered = translation.t(`settings:codeIndex.${key}`, { service: "test-service", time: "local-time" })
		expect(rendered).toContain("test-service")
		expect(rendered).not.toContain("{{")
		if (key.endsWith("Until")) expect(rendered).toContain("local-time")
	}
	expect(embeddings.searchProviderRateLimited).toBeTruthy()
	expect(translation.t("embeddings:searchProviderRateLimited")).toBe(embeddings.searchProviderRateLimited)
	if (locale !== "en") {
		expect(settings.codeIndex.providerWaiting).not.toContain("indexing resumes automatically")
		expect(embeddings.searchProviderRateLimited).not.toContain("Search provider rate-limited")
	}
})
