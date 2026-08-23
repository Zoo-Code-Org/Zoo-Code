import { config } from "@roo-code/config-eslint/base"

import { noRawProviderIdentifiers } from "./eslint-rules/no-raw-provider-identifiers.mjs"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		rules: {
			"prefer-const": ["error", { destructuring: "all" }],

			// TODO: The rules listed below should be re-enabled once their existing violations are fixed.
			"no-regex-spaces": "off",
			"no-useless-escape": "off",
			"no-empty": "off",

			"@typescript-eslint/no-unused-vars": "off",
			// Enforced; existing violations are suppressed in eslint-suppressions.json and cleaned up incrementally.
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/ban-ts-comment": "off",
		},
	},
	{
		files: ["core/assistant-message/presentAssistantMessage.ts", "core/webview/webviewMessageHandler.ts"],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		files: ["__mocks__/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		files: ["**/*.ts", "**/*.tsx"],
		ignores: [
			"**/fixtures/**",
		],
		plugins: {
			zoo: {
				rules: {
					"no-raw-provider-identifiers": noRawProviderIdentifiers,
				},
			},
		},
		rules: {
			"zoo/no-raw-provider-identifiers": "error",
		},
	},
	{
		// Ratchet: enforce no-floating-promises directory by directory. Each
		// directory is added here once its floating promises are resolved.
		files: [
			"activate/**/*.ts",
			"core/config/**/*.ts",
			"core/task/**/*.ts",
			"core/tools/**/*.ts",
			"core/webview/**/*.ts",
			"extension.ts",
			"integrations/**/*.ts",
			"services/**/*.ts",
		],
		languageOptions: {
			parserOptions: {
				project: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
	{
		ignores: ["webview-ui", "out"],
	},
]
