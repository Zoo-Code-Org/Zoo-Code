import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Linter } from "eslint"
import typescriptEslint from "typescript-eslint"

import { i18nLanguageSwitchSelectors } from "./i18n-language-switch.js"

const linter = new Linter({ configType: "flat" })
const config = [
	{
		files: ["**/*.tsx"],
		languageOptions: { parser: typescriptEslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
		rules: { "no-restricted-syntax": ["error", ...i18nLanguageSwitchSelectors] },
	},
]

const lint = (code) => linter.verify(code, config, { filename: "example.tsx" }).map((message) => message.message)

describe("i18n language switch: global t", () => {
	for (const code of [
		'i18next.t("chat:about")',
		'import i18n from "i18next"\ni18n.t("chat:about")',
		'i18n?.t("chat:about")',
		'i18next["t"]("chat:about")',
		'useTranslation().i18n.t("chat:about")',
		"const { t } = i18next",
		"const { t: translate } = i18n",
		"const { t } = useTranslation().i18n",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'const { t } = useTranslation()\nt("chat:about")',
		'i18next.changeLanguage("es")',
		"i18n.language",
		"i18next[t]",
		"const { language } = i18n",
		'other.t("chat:about")',
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})

describe("i18n language switch: aliasing the instance", () => {
	for (const code of [
		'import lang from "i18next"',
		'import { default as lang } from "i18next"',
		'import * as lang from "i18next"',
		'import lang from "@src/i18n/setup"',
		'import lang from "@/i18n/setup"',
		'import lang from "../setup"',
		'export { default as lang } from "i18next"',
		"const lang = i18next",
		"const lang = useTranslation().i18n",
		"lang = i18n",
		"const { i18n: lang } = useTranslation()",
		"const { i18n: { t } } = useTranslation()",
		"function Foo({ i18n: lang }) {}",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'import i18next from "i18next"',
		'import i18n from "i18next"',
		'import i18next, { type TFunction } from "i18next"',
		'import { initReactI18next } from "react-i18next"',
		'import i18next from "@src/i18n/setup"',
		'import { default as i18next } from "i18next"',
		'import config from "./config"',
		"const i18n = useTranslation().i18n",
		"const { i18n } = useTranslation()",
		"const { language } = i18next",
		"const instance = i18next.createInstance()",
		"changeLanguage(i18next)",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})

describe("i18n language switch: Trans", () => {
	for (const code of [
		'<Trans i18nKey="chat:about" />',
		"<Trans components={{ b: <Foo t={1} /> }} />",
		"<Trans {...props} />",
	]) {
		it(`flags a Trans without its own t: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'<Trans t={t} i18nKey="chat:about" />',
		"<Trans t={t} components={{ b: <Foo t={1} /> }} />",
		'<Other i18nKey="chat:about" />',
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})
