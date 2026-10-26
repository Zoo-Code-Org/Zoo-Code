import { config } from "@roo-code/config-eslint/base"
import { apiProviderHygieneConfig, apiProviderTestSelectors } from "@roo-code/config-eslint/api-provider-hygiene"
import { createProviderIdentifierConfig } from "@roo-code/config-eslint/provider-identifiers"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

// Tests must not read files 3+ levels above the test file (see the test override below).
const testPathTraversalSelectors = [
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
]

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }),
	apiProviderHygieneConfig,
	{
		rules: {
			"prefer-const": ["error", { destructuring: "all" }],

			// Enforced; existing violations are suppressed in eslint-suppressions.json and cleaned up incrementally.
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/ban-ts-comment": "off",
		},
	},
	{
		// A Stryker directive gives a short reason. Put longer rationale in the test or a code comment.
		// ignorePattern skips every line that does not contain "Stryker", so only directives are measured.
		rules: {
			"max-len": ["error", { code: 300, ignorePattern: "^(?!.*Stryker).*" }],
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
		// The workflow test files below are the intentional exceptions: they read
		// root-level config and run in a dedicated non-Turbo CI step.
		files: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.spec.ts"],
		ignores: [
			"**/services/__tests__/pr-review-state-workflow.test.ts",
			"**/services/__tests__/stale-pr-clock-workflow.test.ts",
			"**/services/__tests__/fork-review-followup-workflow.test.ts",
			"**/services/__tests__/workflow-self-listen.test.ts",
		],
		rules: {
			"no-restricted-syntax": ["error", ...testPathTraversalSelectors],
		},
	},
	{
		// A later block replaces no-restricted-syntax for the same files, so repeat the traversal selectors.
		files: ["api/**/__tests__/**/*.spec.ts"],
		rules: {
			"no-restricted-syntax": ["error", ...testPathTraversalSelectors, ...apiProviderTestSelectors],
		},
	},
]
