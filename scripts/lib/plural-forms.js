/**
 * Plural key helpers shared by find-missing-translations.js and validate-plural-forms.js.
 *
 * i18next picks a plural form with Intl.PluralRules (CLDR) and looks it up as a key suffix:
 * "files_one", "files_few", "files_many", "files_other". "_zero" is an i18next override for count 0.
 */

const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"]

// i18next plural keys: "files_one", "files_few", ...
const PLURAL_KEY = new RegExp(`^(.*)_(${PLURAL_FORMS.join("|")})$`)

// Groups English plural keys by base name: "files_one", "files_other" -> "files".
// `values` maps each dotted key to its English string.
function findPluralBases(values) {
	const pluralBases = new Map()

	for (const [key, value] of values) {
		const plural = key.match(PLURAL_KEY)
		if (!plural) continue

		const [, base, form] = plural
		if (!pluralBases.has(base)) pluralBases.set(base, { hasZero: false, englishValue: value })
		if (form === "zero") pluralBases.get(base).hasZero = true
		if (form === "other") pluralBases.get(base).englishValue = value
	}

	return pluralBases
}

// The forms a locale needs for one plural key: its CLDR categories (e.g. ru: one, few, many, other; ja: other),
// plus "zero" when the English key has that override. Sorted from "zero" to "other" for readable reports.
function requiredPluralForms(locale, { hasZero }) {
	const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
	return PLURAL_FORMS.filter((form) => categories.includes(form) || (hasZero && form === "zero"))
}

module.exports = { PLURAL_FORMS, PLURAL_KEY, findPluralBases, requiredPluralForms }
