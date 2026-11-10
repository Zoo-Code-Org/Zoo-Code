/**
 * Script to validate i18next plural keys against the CLDR plural rules of every locale, English included
 *
 * Usage:
 *   node scripts/validate-plural-forms.js [options]
 *
 * Options:
 *   --locale=<locale>   Only check a specific locale (e.g. --locale=ru or --locale=en)
 *   --file=<file>       Only check a specific file (e.g. --file=chat.json)
 *   --area=<area>       Only check a specific area (core, webview, or all)
 *   --help              Show this help message
 */

const path = require("path")
const fs = require("fs")
const { PLURAL_FORMS, findPluralBases, requiredPluralForms } = require("./lib/plural-forms")

// Process command line arguments
const args = process.argv.slice(2).reduce(
	(acc, arg) => {
		if (arg === "--help") {
			acc.help = true
		} else if (arg.startsWith("--locale=")) {
			acc.locale = arg.split("=")[1]
		} else if (arg.startsWith("--file=")) {
			acc.file = arg.split("=")[1]
		} else if (arg.startsWith("--area=")) {
			acc.area = arg.split("=")[1]
			if (!["core", "webview", "all"].includes(acc.area)) {
				console.error(`Error: Invalid area '${acc.area}'. Must be 'core', 'webview', or 'all'.`)
				process.exit(1)
			}
		}
		return acc
	},
	{ area: "all" },
)

if (args.help) {
	console.log(`
Validate Plural Forms

Checks that every plural key has exactly the CLDR plural forms of each locale, English included:
  - no missing form (ru needs one, few, many, other; ja needs only other)
  - no form the locale does not have (no _one in ja)
  - no bare key next to the plural forms (i18next uses it in place of a missing form)

The English plural keys decide which keys are plural. Missing locale files are reported
by find-missing-translations.js, so this script skips them.

Usage:
  node scripts/validate-plural-forms.js [options]

Options:
  --locale=<locale>   Only check a specific locale (e.g. --locale=ru or --locale=en)
  --file=<file>       Only check a specific file (e.g. --file=chat.json)
  --area=<area>       Only check a specific area (core, webview, or all)
                      'core' = Backend (src/i18n/locales)
                      'webview' = Frontend UI (webview-ui/src/i18n/locales)
                      'all' = Check all areas (default)
  --help              Show this help message
  `)
	process.exit(0)
}

const LOCALES_DIRS = {
	core: path.join(__dirname, "../src/i18n/locales"),
	webview: path.join(__dirname, "../webview-ui/src/i18n/locales"),
}

// { a: { b: "x" } } -> Map { "a.b" => "x" }
function flatten(obj, parentKey = "", values = new Map()) {
	for (const [key, value] of Object.entries(obj)) {
		const currentKey = parentKey ? `${parentKey}.${key}` : key
		if (typeof value === "object" && value !== null) {
			flatten(value, currentKey, values)
		} else {
			values.set(currentKey, value)
		}
	}
	return values
}

function readJson(filePath) {
	if (!fs.existsSync(filePath)) return null
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (error) {
		console.error(`Error parsing JSON file '${filePath}': ${error.message}`)
		process.exit(1)
	}
}

// Each English plural key must have exactly the locale's forms, and no bare key next to them
function validatePluralForms(locale, values, pluralBases) {
	const problems = []

	for (const [base, entry] of pluralBases) {
		const required = requiredPluralForms(locale, entry)

		for (const form of required) {
			if (!values.has(`${base}_${form}`)) {
				problems.push({ key: `${base}_${form}`, problem: `missing the "${form}" plural form` })
			}
		}

		for (const form of PLURAL_FORMS) {
			if (!required.includes(form) && values.has(`${base}_${form}`)) {
				problems.push({
					key: `${base}_${form}`,
					problem: `"${form}" is not a CLDR plural form for ${locale}; remove it`,
				})
			}
		}

		if (typeof values.get(base) === "string") {
			problems.push({ key: base, problem: "bare key next to plural forms; remove it" })
		}
	}

	return problems
}

function validateArea(area) {
	const localesDir = LOCALES_DIRS[area]
	const allLocales = fs
		.readdirSync(localesDir)
		.filter((item) => fs.statSync(path.join(localesDir, item)).isDirectory())
		.sort()
	const locales = args.locale ? allLocales.filter((locale) => locale === args.locale) : allLocales

	if (args.locale && locales.length === 0) {
		console.error(`Error: Locale '${args.locale}' not found in ${localesDir}`)
		process.exit(1)
	}

	const englishDir = path.join(localesDir, "en")
	let englishFiles = fs.readdirSync(englishDir).filter((file) => file.endsWith(".json") && !file.startsWith("."))

	if (args.file) {
		if (!englishFiles.includes(args.file)) {
			console.error(`Error: File '${args.file}' not found in ${englishDir}`)
			process.exit(1)
		}
		englishFiles = englishFiles.filter((file) => file === args.file)
	}

	const title = area === "core" ? "BACKEND" : "FRONTEND"
	console.log(`\n${title} - Checking plural forms in ${locales.length} locale(s): ${locales.join(", ")}\n`)

	const pluralBases = new Map(
		englishFiles.map((file) => [file, findPluralBases(flatten(readJson(path.join(englishDir, file))))]),
	)
	let hasProblems = false

	for (const locale of locales) {
		const problemsByFile = []

		for (const file of englishFiles) {
			const content = readJson(path.join(localesDir, locale, file))
			if (!content) continue

			const problems = validatePluralForms(locale, flatten(content), pluralBases.get(file))
			if (problems.length > 0) problemsByFile.push({ file, problems })
		}

		if (problemsByFile.length === 0) {
			console.log(`✅ ${locale}: Plural forms are correct`)
			continue
		}

		hasProblems = true
		console.log(`📝 ${locale}:`)
		for (const { file, problems } of problemsByFile) {
			console.log(`  - ${file}: ${problems.length} plural form problem(s)`)
			for (const { key, problem } of problems) {
				console.log(`      ${key}: ${problem}`)
			}
		}
		console.log("")
	}

	return hasProblems
}

const areas = args.area === "all" ? ["core", "webview"] : [args.area]
const hasProblems = areas.map(validateArea).some(Boolean)

if (hasProblems) {
	console.log("\n✏️  Give each plural key exactly the CLDR plural forms of its locale.")
	console.log("List a locale's forms with Intl.PluralRules(<locale>).resolvedOptions().pluralCategories")
	process.exit(1)
}

console.log("\n✅ All plural forms follow the CLDR rules of their locales!")
