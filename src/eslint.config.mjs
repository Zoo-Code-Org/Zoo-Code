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
		ignores: [".stryker-tmp", "webview-ui", "out"],
	},
	{
		// Tests inside __tests__/ directories must not traverse 3+ levels above
		// the test file. That escapes the src/ package root and makes Turbo
		// invisible to cache changes in those files.
		// pr-review-state-workflow.test.ts is the intentional exception: it reads
		// root-level config and runs in a dedicated non-Turbo CI step.
		files: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.spec.ts"],
		ignores: ["**/services/__tests__/pr-review-state-workflow.test.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					// Catches path.resolve(..., "../../..") — the three-level literal ends here.
					selector: "CallExpression > Literal[value=/\\.\\.\\W\\.\\.\\W\\.\\.$/]",
					message:
						"Do not read files 3+ levels above the test file. Tests reading root-level config must run in a dedicated non-Turbo-cached CI step.",
				},
				{
					// Catches readFile("../../../.coderabbit.yaml") — three-level traversal
					// embedded inside a longer path string. Scoped to FS-reading calls so
					// vi.mock("../../../module") (module paths, not file reads) is not flagged.
					// Matches both bare readFileSync(...) and fs.readFileSync(...).
					selector:
						":matches(CallExpression[callee.name=/^(readFile|readFileSync|open|openSync|stat|statSync|access|accessSync|watch|watchFile|readdir|readdirSync)/], CallExpression[callee.property.name=/^(readFile|readFileSync|open|openSync|stat|statSync|access|accessSync|watch|watchFile|readdir|readdirSync)/]) > Literal[value=/\\.\\.\\W\\.\\.\\W\\.\\./]",
					message:
						"Do not read files 3+ levels above the test file. Tests reading root-level config must run in a dedicated non-Turbo-cached CI step.",
				},
			],
		},
	},
]
