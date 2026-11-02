import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { URL } from "node:url"

import { Linter } from "eslint"
import typescriptEslint from "typescript-eslint"

import { createI18nDotKeyConfig } from "./i18n-keys.js"

const linter = new Linter({ configType: "flat" })
const config = [
	{ files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser: typescriptEslint.parser } },
	createI18nDotKeyConfig(new URL("../../webview-ui/src/i18n/locales/en", import.meta.url)),
]

const lint = (code, filename = "components/example.tsx") =>
	linter.verify(code, config, { filename }).map((message) => message.message)

describe("i18n dot-form keys", () => {
	for (const code of [
		't("chat.commandExecution.exitStatus", { exitCode })',
		'i18next.t("settings.autoApprove.title")',
		"t(`chat.errors.${name}`)",
		"t(`chat\\u002ecommandExecution.exitStatus`)",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		't("chat:commandExecution.exitStatus", { exitCode })',
		't("unknownNamespace.key")',
		"t(`chat:errors.${name}`)",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}

	it("does not apply to spec files", () => {
		assert.deepEqual(lint('t("chat.key")', "components/__tests__/example.spec.tsx"), [])
	})
})
