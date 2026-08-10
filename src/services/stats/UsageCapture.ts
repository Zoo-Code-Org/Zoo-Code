import type { ProviderSettings } from "@roo-code/types"

// ── Usage Stats: endpoint domain extraction ──────────────────────────────────

/**
 * Default base URLs per provider. Only providers with a user-configurable
 * base URL field are listed. When the user's configured URL matches the
 * default, `endpoint` is left undefined to keep events clean.
 */
const PROVIDER_DEFAULT_BASE_URLS: Partial<Record<string, string>> = {
	openai: "https://api.openai.com/v1",
	"openai-native": "https://api.openai.com",
	openrouter: "https://openrouter.ai/api/v1",
	deepseek: "https://api.deepseek.com",
	litellm: "http://localhost:4000",
	ollama: "http://127.0.0.1:11434",
	lmstudio: "http://localhost:1234/v1",
	requesty: "https://router.requesty.ai/v1",
	mimo: "https://token-plan-sgp.xiaomimimo.com/v1",
}

/**
 * Maps a provider name to the corresponding base URL field on ProviderSettings.
 * Returns the raw configured value (may be undefined if the user hasn't
 * customized it). Providers not in this map have no user-configurable base URL.
 */
function getProviderBaseUrlField(provider: string, config: ProviderSettings): string | undefined {
	switch (provider) {
		case "anthropic":
			return config.anthropicBaseUrl
		case "openai":
			return config.openAiBaseUrl
		case "openai-native":
			return config.openAiNativeBaseUrl
		case "openrouter":
			return config.openRouterBaseUrl
		case "deepseek":
			return config.deepSeekBaseUrl
		case "litellm":
			return config.litellmBaseUrl
		case "ollama":
			return config.ollamaBaseUrl
		case "lmstudio":
			return config.lmStudioBaseUrl
		case "requesty":
			return config.requestyBaseUrl
		case "mimo":
			return config.mimoBaseUrl
		case "zoo-gateway":
			return config.zooGatewayBaseUrl
		default:
			return undefined
	}
}

/**
 * Extracts a display-friendly endpoint domain from the provider's base URL.
 *
 * Only returns a value when the user has configured a CUSTOM base URL that
 * differs from the provider's default. For localhost / 127.0.0.1 hosts the
 * port is included (e.g. "localhost:1234") so distinct local servers can be
 * distinguished. Returns undefined for default endpoints, providers without
 * a base URL field, or malformed URLs.
 */
export function resolveEndpoint(config: ProviderSettings): string | undefined {
	const provider = config.apiProvider
	if (!provider) return undefined

	const configuredUrl = getProviderBaseUrlField(provider, config)
	if (!configuredUrl) return undefined

	// Only record endpoint when the user customized the base URL.
	const defaultUrl = PROVIDER_DEFAULT_BASE_URLS[provider]
	if (configuredUrl === defaultUrl) return undefined

	// zoo-gateway default is dynamic — skip when it matches the derived default.
	if (provider === "zoo-gateway") {
		// The dynamic default is `${getZooCodeBaseUrl()}/api/gateway/v1`.
		// We can't import getZooCodeBaseUrl here without a circular dependency,
		// so we compare against the known suffix pattern. If the configured URL
		// ends with /api/gateway/v1 and starts with a zoocode host, treat as default.
		if (/^https?:\/\/[^/]*zoocode\.dev\/api\/gateway\/v1\/?$/.test(configuredUrl)) {
			return undefined
		}
	}

	try {
		const url = new URL(configuredUrl)
		const hostname = url.hostname
		// Include port for localhost / 127.0.0.1 so distinct local servers differ.
		if ((hostname === "localhost" || hostname === "127.0.0.1") && url.port) {
			return `${hostname}:${url.port}`
		}
		return hostname
	} catch {
		return undefined
	}
}
