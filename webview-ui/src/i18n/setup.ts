import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Locale JSON files are loaded two ways depending on the runtime:
//   1. Vite (browser build + dev + vitest/CT browser side): the literal
//      `import.meta.glob("./locales/**/*.json", { eager: true })` call below is
//      rewritten at build time into a static map of the parsed modules.
//   2. Node-side ESM consumers (Playwright CT transform, and any bundler that
//      does not implement the Vite glob macro): `import.meta.glob` is not a
//      function, so the call throws and we fall back to reading the JSON files
//      straight off disk with `node:fs`.
//
// Static `import x from "./locales/...json"` statements are deliberately NOT
// used here: Node ESM rejects a bare JSON import without `with { type: "json" }`
// import attributes ("needs an import attribute of \"type: json\""), and that
// attribute syntax is not portable to the Vite browser bundle. Reading from
// disk keeps the fallback free of any JSON import statements.
//
// `node:fs`/`node:path`/`node:url` are only referenced inside the disk-fallback
// path, which never executes in the browser bundle (Vite externalizes these
// builtins to an inert stub). `loadLocaleModulesFromDisk` keeps them behind a
// function boundary so the browser build resolves cleanly.
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { fileURLToPath } from "node:url"

type LocaleModule = Record<string, unknown>

// Build translations object
const translations: Record<string, Record<string, LocaleModule>> = {}

function loadLocaleModulesFromDisk(): Record<string, LocaleModule> {
	const result: Record<string, LocaleModule> = {}
	const localesDir = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "locales")
	if (!nodeFs.existsSync(localesDir)) {
		return result
	}
	const walk = (dir: string, prefix: string) => {
		for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				walk(nodePath.join(dir, entry.name), `${prefix}${entry.name}/`)
			} else if (entry.name.endsWith(".json")) {
				result[`./locales/${prefix}${entry.name}`] = JSON.parse(
					nodeFs.readFileSync(nodePath.join(dir, entry.name), "utf8"),
				)
			}
		}
	}
	walk(localesDir, "")
	return result
}

// Normalize a locale module: both the Vite eager-glob result and the
// disk-loaded JSON may surface the parsed object directly or under `default`
// depending on interop mode. No locale JSON file has a top-level "default" key,
// so preferring `default` when present is safe.
function toLocaleModule(module: unknown): LocaleModule {
	if (typeof module !== "object" || module === null) {
		return {}
	}
	const parsed = module as LocaleModule
	const nested = parsed["default"]
	if (typeof nested === "object" && nested !== null) {
		return nested as LocaleModule
	}
	return parsed
}

// Vite compiles the literal `import.meta.glob` call below into a static object
// at build time, so the browser always receives the fully-populated map and the
// `catch` branch is dead code there. Under non-Vite transforms (Playwright CT,
// Node ESM) `import.meta.glob` is undefined, the call throws, and we fall back
// to reading the same files from disk. A `typeof` guard is intentionally NOT
// used: after Vite rewrite `import.meta.glob` is not defined as a runtime
// property, so a `typeof === "function"` check evaluates false in the browser
// and would wrongly route the production bundle into the disk fallback.
let localeFiles: Record<string, LocaleModule>
try {
	localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })
} catch {
	localeFiles = loadLocaleModulesFromDisk()
}

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
		translations[language][namespace] = toLocaleModule(module)
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
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

export default i18next
