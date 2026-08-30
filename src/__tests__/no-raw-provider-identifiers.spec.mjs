import { Linter } from "eslint"
import typescriptParser from "@typescript-eslint/parser"
import { describe, expect, it } from "vitest"

import { noRawProviderIdentifiers } from "../eslint-rules/no-raw-provider-identifiers.mjs"

const linter = new Linter({ configType: "eslintrc" })

linter.defineRule("zoo/no-raw-provider-identifiers", noRawProviderIdentifiers)
linter.defineParser("@typescript-eslint/parser", typescriptParser)

function lint(code) {
	return linter.verify(code, {
		parserOptions: { ecmaVersion: 2022, sourceType: "module" },
		rules: { "zoo/no-raw-provider-identifiers": "error" },
	})
}

function lintTypeScript(code) {
	return linter.verify(code, {
		parser: "@typescript-eslint/parser",
		parserOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			warnOnUnsupportedTypeScriptVersion: false,
		},
		rules: { "zoo/no-raw-provider-identifiers": "error" },
	})
}

describe("no-raw-provider-identifiers", () => {
	it("rejects a canonical provider literal in an apiProvider property", () => {
		const messages = lint('const config = { apiProvider: "poe" }')

		expect(messages).toHaveLength(1)
		expect(messages[0]).toMatchObject({
			ruleId: "zoo/no-raw-provider-identifiers",
			message: 'Use providerIdentifiers.poe instead of the raw provider identifier "poe".',
		})
	})

	it("allows a non-canonical literal and a canonical registry member", () => {
		expect(lint('const config = { apiProvider: "external-provider" }')).toHaveLength(0)
		expect(lint("const config = { apiProvider: providerIdentifiers.poe }")).toHaveLength(0)
	})

	it("matches provider-like property names and static template literals", () => {
		const messages = lint('const config = { provider: "poe", imageProvider: `openrouter` }')

		expect(messages).toHaveLength(2)
	})

	it("allows an empty static template in a provider-like context", () => {
		expect(lint("const config = { apiProvider: `` }")).toHaveLength(0)
	})

	it("rejects canonical literals in provider-like variable declarations", () => {
		const messages = lint(`
			const apiProvider = "poe"
			let fallbackProvider = \`openrouter\`
			const label = "poe"
		`)

		expect(messages.map(({ message }) => message)).toEqual([
			'Use providerIdentifiers.poe instead of the raw provider identifier "poe".',
			'Use providerIdentifiers.openrouter instead of the raw provider identifier "openrouter".',
		])
	})

	it("rejects canonical provider literals wrapped in TypeScript expressions", () => {
		const messages = lintTypeScript(`
			const apiProvider = "poe" as ApiProvider
			const fallbackProvider = "openrouter" satisfies ApiProvider
			const imageProvider = <ApiProvider>"openai-native"
			const nestedProvider = ("anthropic" as ApiProvider)!
		`)

		expect(messages.map(({ message }) => message)).toEqual([
			'Use providerIdentifiers.poe instead of the raw provider identifier "poe".',
			'Use providerIdentifiers.openrouter instead of the raw provider identifier "openrouter".',
			'Use providerIdentifiers.openaiNative instead of the raw provider identifier "openai-native".',
			'Use providerIdentifiers.anthropic instead of the raw provider identifier "anthropic".',
		])
	})

	it("rejects canonical literals in provider-like class fields", () => {
		const messages = lintTypeScript(`
			class Settings {
				apiProvider = "poe"
				label = "openrouter"
			}
		`)

		expect(messages.map(({ message }) => message)).toEqual([
			'Use providerIdentifiers.poe instead of the raw provider identifier "poe".',
		])
	})

	it("rejects canonical literals in provider-like assignments and comparisons", () => {
		const messages = lint(`
			config["apiProvider"] = "poe"
			if (imageProvider === "openrouter") {}
			if ("openai-native" !== config.fallbackProvider) {}
		`)

		expect(messages.map(({ message }) => message)).toEqual([
			'Use providerIdentifiers.poe instead of the raw provider identifier "poe".',
			'Use providerIdentifiers.openrouter instead of the raw provider identifier "openrouter".',
			'Use providerIdentifiers.openaiNative instead of the raw provider identifier "openai-native".',
		])
	})

	it("rejects canonical literals in provider-like switch cases", () => {
		const messages = lint(`
			switch (config.apiProvider) {
				case "poe": break
				case providerIdentifiers.openrouter: break
			}
		`)

		expect(messages).toHaveLength(1)
		expect(messages[0].message).toContain("providerIdentifiers.poe")
	})

	it("does not report canonical values outside provider-like contexts", () => {
		const messages = lint(`
			const label = "poe"
			const config = { protocol: "anthropic", format: "openai" }
			config[dynamicKey] = "poe"
			if (apiProtocol === "anthropic") {}
			if (provider > "poe") {}
			switch (format) { case "openai": break }
		`)

		expect(messages).toHaveLength(0)
	})
})
