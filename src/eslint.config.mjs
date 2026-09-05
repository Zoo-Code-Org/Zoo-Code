import { config } from "@roo-code/config-eslint/base"
import { createProviderIdentifierConfig } from "@roo-code/config-eslint/provider-identifiers"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }),
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
		// Test-utils rollout guardrail: lanes converted to the shared reset
		// helpers stay converted. Use clearAllMocks from test-utils/reset.
		files: [
			"api/providers/__tests__/**/*.ts",
			"core/config/__tests__/**/*.ts",
			"services/code-index/**/__tests__/**/*.ts",
			"integrations/terminal/**/__tests__/**/*.ts",
		],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector:
						"CallExpression[callee.object.name='vi'][callee.property.name='clearAllMocks'], CallExpression[callee.object.name='vitest'][callee.property.name='clearAllMocks']",
					message:
						"Use the shared clearAllMocks() helper from src/test-utils/reset instead of calling vi.clearAllMocks() directly.",
				},
			],
		},
	},
	{
		ignores: ["webview-ui", "out"],
	},
]
