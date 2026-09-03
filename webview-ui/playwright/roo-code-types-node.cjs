/* eslint no-undef: off, @typescript-eslint/no-require-imports: off */
/**
 * Node-side (Playwright test-runner process) stand-in for `@roo-code/types`.
 *
 * Why this exists
 * ---------------
 * Playwright does NOT use `ctViteConfig` to load test files. It transpiles
 * `.ts`/`.tsx` with its own in-process hooks and loads them inside the Node
 * runner, resolving bare specifiers from the tsconfig supplied via the
 * `tsconfig` option in `playwright-ct.config.ts` (see `node-tsconfig.json`).
 * Without an explicit mapping, `@roo-code/types` resolves through
 * `node_modules/@roo-code/types` -> `package.json#main` -> `dist/index.cjs`,
 * and CI never builds `packages/types`, so module load crashes with
 * `Cannot find module .../@roo-code/types/dist/index.cjs`.
 *
 * Pointing the mapping straight at `packages/types/src/index.ts` does not
 * work either: the barrel transitively requires `ai-sdk-provider-poe/code`,
 * whose package `exports` map has no CommonJS condition, so the Node-side
 * require fails with ERR_PACKAGE_PATH_NOT_EXPORTED (and Node's native
 * require(esm) path additionally rejects the package's `./x.js` specifiers
 * that only exist as `./x.ts` sources).
 *
 * What the Node-side graph actually imports at RUNTIME (the heavy real
 * `ExtensionStateContext` -> `checkExistApiConfig` / `modes` chain is
 * severed Node-side by `node-tsconfig.json` pointing both context spellings
 * at `ExtensionStateContext.mock.tsx`, mirroring the browser side):
 *
 * - `providerIdentifiers` — DashboardView/TaskList/OpenAICompatible visual
 *   files and fixtures. Loaded from the real
 *   `packages/types/src/provider-identifiers.ts` source (zero dependencies,
 *   loads under both Playwright's CJS transform and Node's native TypeScript
 *   require) — single source of truth, no drift.
 * - `OpenAiServiceTier` / `OpenAiCodexServiceTier` — ModelInfoView and
 *   OpenAICodex fixtures. Inlined (the real `model.ts` drags in the Zod +
 *   provider-settings chain). Values mirror
 *   `packages/types/src/model.ts` exactly; they are persisted-stable string
 *   registries.
 * - The remaining constants below (`SECRET_STATE_KEYS`, `GLOBAL_SECRET_KEYS`,
 *   `isLanguage`, `ORGANIZATION_ALLOW_ALL`, `DEFAULT_CHECKPOINT_TIMEOUT_SECONDS`,
 *   `DEFAULT_DIFF_FUZZY_THRESHOLD`, `RouterModelsMessageType`) are defensive:
 *   no current Node-side importer needs them, but if a future visual-test
 *   import graph reaches `src/shared/checkExistApiConfig.ts` or
 *   `ExtensionStateContext` again, these prevent a re-crash of the whole
 *   CI job. They mirror `packages/types/src/global-settings.ts`, `cloud.ts`,
 *   `model.ts` and `vscode.ts`.
 *
 * Type-only imports (`ProviderSettings`, `ModelInfo`, `StatsBucket`,
 * `DashboardTaskSummary`, `ExtensionStateContextType`, …) are erased by the
 * transform and need no runtime entry.
 *
 * IMPORTANT: the individual `exports.NAME = ...` assignments are deliberate.
 * ESM-format test modules (webview-ui is a `"type": "module"` package) import
 * named specifiers from `@roo-code/types`; Node's `cjs-module-lexer` only
 * detects static named exports written this way, so an opaque
 * `module.exports = require(...)` re-export breaks ESM named imports with
 * "does not provide an export named ...". If a future visual test needs
 * another RUNTIME value from the package, add it to the list below.
 */
const providerIdModules = require("../../packages/types/src/provider-identifiers.ts")

const OpenAiServiceTier = {
	Default: "default",
	Flex: "flex",
	Priority: "priority",
}

const OpenAiCodexServiceTier = {
	Default: "default",
	Fast: "fast",
}

const SECRET_STATE_KEYS = [
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsApiKey",
	"awsSecretKey",
	"awsSessionToken",
	"openAiApiKey",
	"ollamaApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"deepSeekApiKey",
	"moonshotApiKey",
	"kimiCodeApiKey",
	"mistralApiKey",
	"minimaxApiKey",
	"requestyApiKey",
	"unboundApiKey",
	"xaiApiKey",
	"litellmApiKey",
	"codeIndexOpenAiKey",
	"codeIndexQdrantApiKey",
	"codebaseIndexOpenAiCompatibleApiKey",
	"codebaseIndexGeminiApiKey",
	"codebaseIndexMistralApiKey",
	"codebaseIndexVercelAiGatewayApiKey",
	"codebaseIndexOpenRouterApiKey",
	"sambaNovaApiKey",
	"zaiApiKey",
	"fireworksApiKey",
	"friendliApiKey",
	"vercelAiGatewayApiKey",
	"opencodeGoApiKey",
	"kenariApiKey",
	"nanoGptApiKey",
	"basetenApiKey",
]

const GLOBAL_SECRET_KEYS = ["openRouterImageApiKey"]

const languages = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
]

exports.providerIdentifiers = providerIdModules.providerIdentifiers
exports.retiredProviderIdentifiers = providerIdModules.retiredProviderIdentifiers
exports.SECRET_STATE_KEYS = SECRET_STATE_KEYS
exports.GLOBAL_SECRET_KEYS = GLOBAL_SECRET_KEYS
exports.isLanguage = (value) => languages.includes(value)
exports.OpenAiServiceTier = OpenAiServiceTier
exports.OpenAiCodexServiceTier = OpenAiCodexServiceTier
exports.ORGANIZATION_ALLOW_ALL = { allowAll: true, providers: {}, wildcard: "*" }
exports.DEFAULT_CHECKPOINT_TIMEOUT_SECONDS = 15
exports.DEFAULT_DIFF_FUZZY_THRESHOLD = 1.0
exports.RouterModelsMessageType = {
	FlushRouterModels: "flushRouterModels",
	RequestRouterModels: "requestRouterModels",
	RouterModels: "routerModels",
	SingleRouterModelFetchResponse: "singleRouterModelFetchResponse",
}
