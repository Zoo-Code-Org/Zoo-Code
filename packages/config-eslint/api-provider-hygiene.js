// Guards for repeat review findings in src/api. Built-in no-restricted-syntax only: no custom rule code.
// Sources: shared helpers live in src/api/providers/utils/abort-signal.ts.
// Paths are relative to the `src` package, where this config is loaded.

const sharedAbortHelpers =
	"mergeAbortSignalAndTimeout|mergeAbortSignals|throwIfAborted|isRequestAborted|createAbortError|rejectOnAbort|resolveModelWithAbort|bridgeExternalAbortSignal|hasUsableTimeout|toSdkTimeoutMs"

// Names that usually hold a secret or an endpoint that can embed credentials.
// `cacheKey` and `contextTokens` must not match.
const sensitiveName = "^(url|apiKey|secret|password)$|(Url|URL|ApiKey|Secret|Token)$"

// A per-request `timeoutMs` from CompletePromptOptions. `this.timeoutMs` is the client-level
// timeout from getApiRequestTimeout, which is already valid, so it must not match.
const rawRequestTimeout =
	":matches(Identifier[name='timeoutMs'], MemberExpression[property.name='timeoutMs']:not([object.type='ThisExpression']), ChainExpression[expression.property.name='timeoutMs'])"

export const apiProviderHygieneSelectors = [
	{
		selector: `:matches(FunctionDeclaration, VariableDeclarator)[id.name=/^(${sharedAbortHelpers})$/]`,
		message: "Import this helper from providers/utils/abort-signal instead of declaring a local copy.",
	},
	{
		selector:
			"CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']:not([arguments.0.type='Literal']):not([arguments.0.name=/^[A-Z][A-Z0-9_]*$/])",
		message:
			"Use mergeAbortSignalAndTimeout for a variable delay. AbortSignal.timeout throws on Infinity and fractions, and clamps large values to 1 ms.",
	},
	{
		selector: `:matches(Property[key.name='timeout'], AssignmentExpression[left.property.name='timeout']) > ${rawRequestTimeout}`,
		message:
			"Do not forward a request timeoutMs as is. A SDK treats 0 as an immediate abort and throws on negative, non-finite or fractional values. Use hasUsableTimeout and toSdkTimeoutMs.",
	},
	{
		selector: "Literal[value=2147483647]",
		message:
			"Do not write the maximum timer delay by hand. Use MAX_TIMEOUT_MS or toSdkTimeoutMs from providers/utils/abort-signal.",
	},
	{
		selector: `CallExpression[callee.object.name='console'] TemplateLiteral > :matches(Identifier[name=/${sensitiveName}/], MemberExpression[property.name=/${sensitiveName}/])`,
		message:
			"Do not log a URL, key, secret or token. A base URL can embed credentials or query secrets. Log the origin only.",
	},
]

export const apiProviderHygieneConfig = {
	files: ["api/**/*.ts"],
	// The helper module owns the shared names. Tests build their own fixtures.
	ignores: ["api/providers/utils/abort-signal.ts", "**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
	rules: {
		"no-restricted-syntax": ["error", ...apiProviderHygieneSelectors],
	},
}

// Spec files under src/api. A loop of expects in one test stops at the first failing case and hides the rest.
export const apiProviderTestSelectors = [
	{
		selector: "ForOfStatement[right.type='ArrayExpression']:has(CallExpression[callee.name='expect'])",
		message:
			"Use it.each for repeated cases. A loop of expects in one test stops at the first failing case and does not name it.",
	},
]
