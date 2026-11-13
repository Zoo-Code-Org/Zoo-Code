import { reactConfig } from "@roo-code/config-eslint/react"
import { i18nLanguageSwitchSelectors } from "@roo-code/config-eslint/i18n-language-switch"
import { createProviderIdentifierConfig } from "@roo-code/config-eslint/provider-identifiers"
import { createI18nDotKeyConfig, getI18nDotKeySelectors } from "@roo-code/config-eslint/i18n-keys"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

const i18nDotKeyConfig = createI18nDotKeyConfig(`${import.meta.dirname}/src/i18n/locales/en`)

/** @type {import("eslint").Linter.Config} */
export default [
	{ ignores: ["playwright/.cache/**"] },
	...reactConfig,
	createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }),
	i18nDotKeyConfig,
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
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "debounce",
							message:
								"Use @src/utils/leadingEdgeDebounce for leading-edge, or useDebounceEffect for trailing.",
						},
					],
				},
			],
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
		files: ["playwright/run-docker.mjs"],
		languageOptions: {
			globals: {
				process: "readonly",
			},
		},
	},
	{
		files: ["src/**/*.{ts,tsx}"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "axios",
							message:
								"axios was removed from the webview bundle in favour of global fetch. Use fetch() for network calls. The dependency is no longer declared in webview-ui/package.json, so an import here only resolves through the hoisted store and would fail at build time.",
						},
						{
							name: "i18next",
							importNames: ["t"],
							message: "Use t from useAppTranslation so memoized output follows language changes.",
						},
						{
							name: "react-i18next",
							importNames: ["useTranslation"],
							message:
								"Use useAppTranslation from @src/i18n/TranslationContext: it loads the selected language and exposes the active one for date formatting.",
						},
					],
				},
			],
			"no-restricted-syntax": ["error", ...i18nLanguageSwitchSelectors],
		},
	},
	{
		// The block above replaces no-restricted-syntax for the same files, so repeat the i18n dot-key
		// selectors. Keep the dot-key config's ignores so test files stay out of that check.
		...i18nDotKeyConfig,
		files: ["src/**/*.{ts,tsx}"],
		rules: {
			"no-restricted-syntax": [
				"error",
				...i18nLanguageSwitchSelectors,
				...getI18nDotKeySelectors(i18nDotKeyConfig),
			],
		},
	},
	{
		// The provider is the one place that reads react-i18next's useTranslation.
		files: ["src/i18n/TranslationContext.tsx"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "i18next",
							importNames: ["t"],
							message: "Use t from useAppTranslation so memoized output follows language changes.",
						},
					],
				},
			],
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
		// Hook specs (including .tsx ones) keep local renderHook wrappers since
		// they pass a specific QueryClient instance to the hook, and Playwright
		// visual fixtures mount real providers inside stories rather than Vitest
		// renders.
		files: ["src/components/**/__tests__/**/*.tsx"],
		ignores: [
			"src/components/**/hooks/**/__tests__/**/*.tsx",
			"src/components/**/__tests__/**/*.visual.fixture.tsx",
		],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "axios",
							message:
								"axios was removed from the webview bundle in favour of global fetch. Use fetch() for network calls. The dependency is no longer declared in webview-ui/package.json, so an import here only resolves through the hoisted store and would fail at build time.",
						},
						{
							name: "i18next",
							importNames: ["t"],
							message: "Use t from useAppTranslation so memoized output follows language changes.",
						},
						{
							name: "react-i18next",
							importNames: ["useTranslation"],
							message:
								"Use useAppTranslation from @src/i18n/TranslationContext: it loads the selected language and exposes the active one for date formatting.",
						},
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
