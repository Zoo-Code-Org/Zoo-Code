import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"
import onlyWarn from "eslint-plugin-only-warn"

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
	js.configs.recommended,
	eslintConfigPrettier,
	...tseslint.configs.recommended,
	{
		plugins: {
			turbo: turboPlugin,
		},
		rules: {
			"turbo/no-undeclared-env-vars": "off",
		},
	},
	{
		plugins: {
			onlyWarn,
		},
	},
	{
		ignores: ["dist/**"],
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			// Reject irregular whitespace (incl. zero-width space U+200B and
			// BOM U+FEFF) in identifiers and between tokens. This rule does NOT
			// catch bidi-override, ZWJ/ZWNJ, or word-joiner characters; the CI
			// invisible-chars job in code-qa.yml is the authoritative defense
			// for the full Trojan Source character set across all files.
			"no-irregular-whitespace": [
				"error",
				{ skipStrings: true, skipComments: false, skipRegExps: true, skipTemplates: false },
			],
		},
	},
]
