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
			// Reject invisible/irregular whitespace (zero-width chars, etc.) in
			// identifiers and between tokens. String literals are skipped to
			// avoid noise in i18n locale files; the CI invisible-chars job in
			// code-qa.yml is the authoritative defense for the string case
			// (it scans raw bytes across strings, identifiers, and comments).
			"no-irregular-whitespace": [
				"error",
				{ skipStrings: true, skipComments: false, skipRegExps: true, skipTemplates: false },
			],
		},
	},
]
