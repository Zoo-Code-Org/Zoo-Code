import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { commonFiles, en, ja, locales, ru, runScript } from "./lib/translation-fixture.mjs"

const run = (files, args) => runScript("validate-plural-forms.js", files, args)
const validate = (byLocale, args = []) => run(commonFiles(byLocale), ["--area=core", ...args])

describe("validate-plural-forms", () => {
	it("accepts exactly the CLDR forms in every locale, English included", () => {
		const { status, output } = validate({ en, ru, ja, fr: { ...en, files_many: "{{count}} fichiers" } })
		assert.equal(status, 0, output)
		for (const locale of ["en", "fr", "ja", "ru"]) {
			assert.match(output, new RegExp(`✅ ${locale}: Plural forms are correct`))
		}
	})

	it("accepts a zero override when every locale has it", () => {
		const { status, output } = validate({
			en: { ...en, files_zero: "No files" },
			ru: { ...ru, files_zero: "Нет файлов" },
		})
		assert.equal(status, 0, output)
	})

	it("lists missing forms from zero to other", () => {
		const { status, output } = validate({ en: { ...en, files_zero: "No files" }, fr: {}, ru: {} })
		assert.equal(status, 1, output)
		const forms = (locale) =>
			[
				...output
					.split(`📝 ${locale}:`)[1]
					.split("📝")[0]
					.matchAll(/files_(\w+): missing/g),
			].map(([, form]) => form)
		assert.deepEqual(forms("fr"), ["zero", "one", "many", "other"])
		assert.deepEqual(forms("ru"), ["zero", "one", "few", "many", "other"])
	})

	it("ignores keys that are not plural", () => {
		const { status, output } = validate({ en: { ...en, title: "Files" }, ja })
		assert.equal(status, 0, output)
	})

	for (const [name, byLocale, locale, expected] of [
		[
			"a missing CLDR form",
			{ en, ru: { ...ru, files_few: undefined } },
			"ru",
			/files_few: missing the "few" plural form/,
		],
		["a missing many form in fr", { en, fr: en }, "fr", /files_many: missing the "many" plural form/],
		[
			"a form the locale does not have",
			{ en, ja: { ...ja, files_one: "1 ファイル" } },
			"ja",
			/files_one: "one" is not a CLDR plural form for ja; remove it/,
		],
		[
			"a bare key next to plural forms",
			{ en, ru: { ...ru, files: "{{count}} файл" } },
			"ru",
			/files: bare key next to plural forms; remove it/,
		],
		[
			"a missing zero override that English has",
			{ en: { ...en, files_zero: "No files" }, ru },
			"ru",
			/files_zero: missing the "zero" plural form/,
		],
		["English with only _other", { en: { files_other: en.files_other }, ja }, "en", /files_one: missing the "one"/],
		[
			"a form English does not have",
			{ en: { ...en, files_few: "{{count}} files" }, ja },
			"en",
			/files_few: "few" is not a CLDR plural form for en/,
		],
		[
			"a bare key next to plural forms in English",
			{ en: { ...en, files: "{{count}} file" }, ja },
			"en",
			/files: bare key next to plural forms/,
		],
		[
			"a bare key in place of the plural forms",
			{ en, ru: { files: "{{count}} файлов" } },
			"ru",
			/files_few: missing the "few" plural form/,
		],
	]) {
		it(`rejects ${name}`, () => {
			const { status, output } = validate(byLocale)
			assert.equal(status, 1, output)
			assert.match(output, new RegExp(`📝 ${locale}:`))
			assert.match(output, expected)
		})
	}

	it("skips a locale file that is missing, which find-missing-translations.js reports", () => {
		const files = locales("core", { en: { "common.json": en, "chat.json": en }, ja: { "common.json": ja } })
		const { status, output } = run(files, ["--area=core"])
		assert.equal(status, 0, output)
	})

	it("checks the webview locales with --area=webview", () => {
		const files = locales("webview", { en: { "chat.json": en }, ja: { "chat.json": { ...ja, files_one: "1" } } })
		const { status, output } = run(files, ["--area=webview"])
		assert.equal(status, 1, output)
		assert.match(output, /FRONTEND - Checking plural forms/)
		assert.match(output, /files_one: "one" is not a CLDR plural form for ja/)
	})
})

describe("validate-plural-forms options", () => {
	const fixture = commonFiles({ en: { files_other: en.files_other }, ja: { ...ja, files_one: "1" } })

	it("--locale=en checks only English", () => {
		const { status, output } = run(fixture, ["--area=core", "--locale=en"])
		assert.equal(status, 1, output)
		assert.match(output, /📝 en:/)
		assert.doesNotMatch(output, /ja/)
	})

	it("--locale checks only that locale", () => {
		const { status, output } = run(fixture, ["--area=core", "--locale=ja"])
		assert.equal(status, 1, output)
		assert.match(output, /📝 ja:/)
		assert.doesNotMatch(output, /en:/)
	})

	it("--file checks only that file", () => {
		const files = locales("core", {
			en: { "common.json": en, "chat.json": en },
			ja: { "common.json": ja, "chat.json": { ...ja, files_one: "1" } },
		})
		const { status, output } = run(files, ["--area=core", "--file=common.json"])
		assert.equal(status, 0, output)
	})

	for (const [name, args, expected] of [
		["an unknown locale", ["--area=core", "--locale=xx"], /Locale 'xx' not found/],
		["an unknown file", ["--area=core", "--file=missing.json"], /File 'missing\.json' not found/],
		["an unknown area", ["--area=package-nls"], /Invalid area 'package-nls'/],
	]) {
		it(`fails on ${name}`, () => {
			const { status, output } = run(fixture, args)
			assert.equal(status, 1, output)
			assert.match(output, expected)
		})
	}

	it("fails on a locale file that is not valid JSON", () => {
		const { status, output } = run({ ...commonFiles({ en }), "src/i18n/locales/ru/common.json": "{ not json" }, [
			"--area=core",
		])
		assert.equal(status, 1, output)
		assert.match(output, /Error parsing JSON file .*ru.*common\.json/)
	})

	it("--help prints usage without checking", () => {
		const { status, output } = run({}, ["--help"])
		assert.equal(status, 0, output)
		assert.match(output, /Usage:/)
		assert.doesNotMatch(output, /Checking plural forms/)
	})
})
