import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// Dynamically load locale files
const localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json/)

	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		translations[language][namespace] = (module as any).default || module
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// The language is switched by the "state" message handler in ExtensionStateContext (see applyLanguage)
i18next.use(initReactI18next).init({
	lng: "en", // Default language (will be overridden)
	fallbackLng: "en",
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export function loadTranslations() {
	Object.entries(translations).forEach(([lang, namespaces]) => {
		try {
			Object.entries(namespaces).forEach(([namespace, resources]) => {
				i18next.addResourceBundle(lang, namespace, resources, true, true)
			})
		} catch (error) {
			console.warn(`Could not load ${lang} translations:`, error)
		}
	})
}

// The locale files are bundled eagerly, so register them before the first render instead of
// in a mount effect, which ran after children had already rendered raw keys.
loadTranslations()

export default i18next
