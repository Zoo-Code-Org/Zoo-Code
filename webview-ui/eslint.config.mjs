import { reactConfig } from "@roo-code/config-eslint/react"
import { createProviderIdentifierConfig } from "@roo-code/config-eslint/provider-identifiers"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

/** @type {import("eslint").Linter.Config} */
export default [
	...reactConfig,
	createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }),
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					args: "all",
					ignoreRestSiblings: true,
					varsIgnorePattern: "^_",
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "off",
			"react/prop-types": "off",
			"react/display-name": "off",
		},
	},
	{
		files: ["src/components/chat/ChatRow.tsx", "src/components/settings/ModelInfoView.tsx"],
		rules: {
			"react/jsx-key": "off",
		},
	},
	{
		files: [
			"src/components/chat/ChatRow.tsx",
			"src/components/chat/ChatView.tsx",
			"src/components/chat/BrowserSessionRow.tsx",
			"src/components/history/useTaskSearch.ts",
		],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		files: ["src/__mocks__/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		// Test-utils rollout guardrail: component specs render through the shared
		// renderWithExtensionState helper instead of hand-wrapping providers.
		// Scoped to .tsx component specs; .ts hook specs keep local renderHook
		// wrappers since they pass a specific QueryClient instance to the hook.
		files: ["src/components/**/__tests__/**/*.tsx"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "@tanstack/react-query",
							importNames: ["QueryClientProvider"],
							message:
								"Use renderWithExtensionState from @/utils/test-utils instead of hand-wrapping QueryClientProvider in component specs.",
						},
					],
				},
			],
		},
	},
]
