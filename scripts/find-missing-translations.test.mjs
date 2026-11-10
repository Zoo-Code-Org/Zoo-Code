import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { commonFiles, en, ja, locales, ru, runScript } from "./lib/translation-fixture.mjs"

const run = (files, args) => runScript("find-missing-translations.js", files, args)

// Plural fixtures in a single common.json per locale.
const checkPlurals = (byLocale) => run(commonFiles(byLocale), ["--area=core"])

describe("find-missing-translations keys", () => {
	const en = { "common.json": { title: "Title", errors: { notFound: "Not found" } } }

	it("accepts a locale that has every English key", () => {
		const { status, output } = run(
			locales("core", { en, ru: { "common.json": { title: "Заголовок", errors: { notFound: "Не найдено" } } } }),
			["--area=core"],
		)
		assert.equal(status, 0, output)
		assert.match(output, /✅ ru: No missing translations/)
	})

	it("accepts extra keys that English does not have", () => {
		const ru = { "common.json": { title: "Заголовок", errors: { notFound: "Не найдено", old: "Старое" } } }
		const { status, output } = run(locales("core", { en, ru }), ["--area=core"])
		assert.equal(status, 0, output)
	})

	it("reports a missing nested key with its English value", () => {
		const { status, output } = run(locales("core", { en, ru: { "common.json": { title: "Заголовок" } } }), [
			"--area=core",
		])
		assert.equal(status, 1, output)
		assert.match(output, /📝 ru:/)
		assert.match(output, /common\.json: 1 missing translations/)
		assert.match(output, /errors\.notFound: "Not found"/)
	})

	it("reports a locale file that is missing entirely", () => {
		const { status, output } = run(
			locales("core", { en: { ...en, "chat.json": { send: "Send" } }, ru: { "common.json": en["common.json"] } }),
			["--area=core"],
		)
		assert.equal(status, 1, output)
		assert.match(output, /chat\.json: File is missing entirely/)
	})

	it("checks the webview locales with --area=webview", () => {
		const { status, output } = run(locales("webview", { en, ru: { "common.json": { title: "Заголовок" } } }), [
			"--area=webview",
		])
		assert.equal(status, 1, output)
		assert.match(output, /FRONTEND Missing Translations Report/)
		assert.match(output, /errors\.notFound/)
	})

	it("fails on a locale file that is not valid JSON", () => {
		const { status, output } = run(locales("core", { en, ru: { "common.json": "{ not json" } }), ["--area=core"])
		assert.equal(status, 1, output)
		assert.match(output, /Error parsing JSON file .*ru.*common\.json/)
	})
})

describe("find-missing-translations options", () => {
	const fixture = locales("core", {
		en: { "common.json": { title: "Title" }, "chat.json": { send: "Send" } },
		ru: { "common.json": {}, "chat.json": { send: "Отправить" } },
		ja: { "common.json": { title: "タイトル" }, "chat.json": {} },
	})

	it("--locale checks only that locale", () => {
		const { status, output } = run(fixture, ["--area=core", "--locale=ja"])
		assert.equal(status, 1, output)
		assert.match(output, /chat\.json: 1 missing translations/)
		assert.doesNotMatch(output, /ru:/)
	})

	it("--file checks only that file", () => {
		const { status, output } = run(fixture, ["--area=core", "--file=chat.json"])
		assert.equal(status, 1, output)
		assert.match(output, /send: "Send"/)
		assert.doesNotMatch(output, /title: "Title"/)
	})

	it("passes when the filtered locale and file are complete", () => {
		const { status, output } = run(fixture, ["--area=core", "--locale=ru", "--file=chat.json"])
		assert.equal(status, 0, output)
	})

	for (const [name, args, expected] of [
		["an unknown locale", ["--area=core", "--locale=xx"], /Locale 'xx' not found/],
		["an unknown file", ["--area=core", "--file=missing.json"], /File 'missing\.json' not found/],
		["an unknown area", ["--area=backend"], /Invalid area 'backend'/],
	]) {
		it(`fails on ${name}`, () => {
			const { status, output } = run(fixture, args)
			assert.equal(status, 1, output)
			assert.match(output, expected)
		})
	}

	it("--help prints usage without checking", () => {
		const { status, output } = run({}, ["--help"])
		assert.equal(status, 0, output)
		assert.match(output, /Usage:/)
		assert.doesNotMatch(output, /Starting translation check/)
	})
})

describe("find-missing-translations package.nls", () => {
	const base = { "extension.displayName": "Zoo Code", "command.newTask": "New Task" }

	it("accepts a locale file that has every base key", () => {
		const { status, output } = run(
			{ "src/package.nls.json": base, "src/package.nls.ru.json": { ...base, "command.newTask": "Новая задача" } },
			["--area=package-nls"],
		)
		assert.equal(status, 0, output)
	})

	it("reports a key missing from a locale file", () => {
		const { status, output } = run(
			{ "src/package.nls.json": base, "src/package.nls.ru.json": { "extension.displayName": "Zoo Code" } },
			["--area=package-nls"],
		)
		assert.equal(status, 1, output)
		assert.match(output, /command\.newTask: "New Task"/)
	})

	it("fails on a nested object in a locale file", () => {
		const { status, output } = run(
			{
				"src/package.nls.json": base,
				"src/package.nls.ru.json": { ...base, command: { newTask: "Новая задача" } },
			},
			["--area=package-nls"],
		)
		assert.equal(status, 1, output)
		assert.match(output, /should be a flat JSON structure. Found nested object at key 'command'/)
	})

	it("skips the check when the base file is missing", () => {
		const { status, output } = run({ "src/package.nls.ru.json": base }, ["--area=package-nls"])
		assert.equal(status, 0, output)
		assert.match(output, /Base package\.nls\.json not found/)
	})
})

describe("find-missing-translations plural keys", () => {
	it("accepts a locale with the CLDR forms of each plural key", () => {
		const { status, output } = checkPlurals({ en, ru, ja, fr: { ...en, files_many: "{{count}} fichiers" } })
		assert.equal(status, 0, output)
	})

	it("reports a plural key when the locale has no key with its base name", () => {
		const { status, output } = checkPlurals({ en, ru: { other_one: "{{count}} другой" } })
		assert.equal(status, 1, output)
		assert.match(output, /common\.json: 1 missing translations/)
		assert.match(output, /files_\*: "\{\{count\}\} files"/)
	})

	it("reports a plural key once, however many forms the locale needs", () => {
		const { output } = checkPlurals({ en: { ...en, files_zero: "No files" }, ru: {} })
		assert.equal(output.match(/files_/g).length, 1, output)
	})

	// validate-plural-forms.js checks the forms; a missing-translations check must not fail on them
	for (const [name, byLocale] of [
		["a missing CLDR form", { en, ru: { ...ru, files_few: undefined } }],
		["a missing many form in fr", { en, fr: en }],
		["a missing zero override that English has", { en: { ...en, files_zero: "No files" }, ru }],
		["an extra form the locale does not have", { en, ja: { ...ja, files_one: "1 ファイル" } }],
		["a bare key next to plural forms", { en, ru: { ...ru, files: "{{count}} файл" } }],
		["a bare key in place of the plural forms", { en, ru: { files: "{{count}} файлов" } }],
		["English with only _other", { en: { files_other: en.files_other }, ja }],
	]) {
		it(`accepts ${name}`, () => {
			const { status, output } = checkPlurals(byLocale)
			assert.equal(status, 0, output)
		})
	}

	it("still reports missing keys that are not plural", () => {
		const { status, output } = checkPlurals({ en: { ...en, title: "Files" }, ru })
		assert.equal(status, 1, output)
		assert.match(output, /title: "Files"/)
	})
})
