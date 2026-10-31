import i18next from "i18next"
import { initReactI18next } from "react-i18next"

/**
 * The only locale bundled into the webview entry chunk. Every other locale is
 * fetched on demand by `loadLanguage` so first paint does not pay for
 * translations the user may never read.
 */
export const FALLBACK_LANGUAGE = "en"

/**
 * A locale JSON file is a tree of translated strings, e.g.
 * `{ "errorBoundary": { "title": "Something went wrong" } }`. Typing the leaves
 * keeps the values checked on their way into `i18next.addResourceBundle`.
 */
type LocaleResources = { [key: string]: string | LocaleResources }
type LocaleModule = { default?: LocaleResources } & LocaleResources

// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
const LOCALE_PATH_PATTERN = /\.\/locales\/([^/]+)\/([^/]+)\.json$/

const eagerLocaleFiles = import.meta.glob<LocaleModule>("./locales/en/*.json", { eager: true })
const lazyLocaleFiles = import.meta.glob<LocaleModule>("./locales/**/*.json")

const pendingLanguages = new Map<string, Promise<void>>()
const loadedLanguages = new Set<string>([FALLBACK_LANGUAGE])

function parseLocalePath(path: string) {
	const match = path.match(LOCALE_PATH_PATTERN)

	return match ? { language: match[1], namespace: match[2] } : undefined
}

function collectLocaleResources(files: Record<string, LocaleModule>) {
	const resources: Record<string, Record<string, LocaleResources>> = {}

	Object.entries(files).forEach(([path, module]) => {
		const parsed = parseLocalePath(path)

		if (!parsed) {
			return
		}

		const { language, namespace } = parsed
		resources[language] = resources[language] || {}
		resources[language][namespace] = module.default || module
	})

	return resources
}

/**
 * Register a locale's namespaces with i18next, fetching them on first use.
 *
 * Resolves even when the fetch fails so callers fall back to
 * `FALLBACK_LANGUAGE` through i18next's `fallbackLng` instead of blocking the
 * UI on a broken chunk. Concurrent calls for the same language share one fetch.
 */
export function loadLanguage(language: string): Promise<void> {
	if (loadedLanguages.has(language)) {
		return Promise.resolve()
	}

	const pending = pendingLanguages.get(language)

	if (pending) {
		return pending
	}

	const loaders = Object.entries(lazyLocaleFiles)
		.filter(([path]) => parseLocalePath(path)?.language === language)
		.map(([path, load]) => load().then((module) => ({ path, module })))

	// Unknown language: leave the fallback bundles in place so i18next resolves
	// every key through `fallbackLng`.
	if (loaders.length === 0) {
		loadedLanguages.add(language)
		return Promise.resolve()
	}

	const promise = Promise.all(loaders)
		.then((modules) => {
			modules.forEach(({ path, module }) => {
				const parsed = parseLocalePath(path)

				if (!parsed) {
					return
				}

				i18next.addResourceBundle(parsed.language, parsed.namespace, module.default || module, true, true)
			})

			loadedLanguages.add(language)
		})
		.catch((error) => {
			console.warn(`Could not load ${language} translations:`, error)
		})
		.finally(() => {
			pendingLanguages.delete(language)
		})

	pendingLanguages.set(language, promise)

	return promise
}

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
i18next.use(initReactI18next).init({
	lng: FALLBACK_LANGUAGE, // Default language (will be overridden)
	fallbackLng: FALLBACK_LANGUAGE,
	debug: false,
	// Handed to `init` rather than added afterwards so the first render already
	// resolves keys; `addResourceBundle` before init settles would be dropped.
	resources: collectLocaleResources(eagerLocaleFiles),
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export default i18next
