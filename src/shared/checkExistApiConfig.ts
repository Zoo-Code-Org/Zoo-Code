import { SECRET_STATE_KEYS, GLOBAL_SECRET_KEYS, ProviderSettings } from "@roo-code/types"

/**
 * Returns whether a provider profile is sufficiently configured to leave the
 * welcome/setup gate.
 *
 * `zooCodeIsAuthenticated` is needed for Zoo Gateway: auth lives in global
 * secret storage (`zoo-code-auth`), and `zooSessionToken` is not part of
 * `SECRET_STATE_KEYS`, so session-auth alone would otherwise look unconfigured.
 */
export function checkExistKey(config: ProviderSettings | undefined, zooCodeIsAuthenticated?: boolean) {
	if (!config) {
		return false
	}

	// Special case for fake-ai, openai-codex, and qwen-code providers which don't need any configuration.
	if (config.apiProvider && ["fake-ai", "openai-codex", "qwen-code"].includes(config.apiProvider)) {
		return true
	}

	if (config.apiProvider === "kimi-code" && (config.kimiCodeAuthMethod ?? "oauth") === "oauth") {
		return true
	}

	// Zoo Gateway uses session auth (profile token and/or global Zoo Code login),
	// not a traditional API key listed in SECRET_STATE_KEYS.
	if (config.apiProvider === "zoo-gateway") {
		return Boolean(config.zooSessionToken) || Boolean(zooCodeIsAuthenticated)
	}

	// Check all secret keys from the centralized SECRET_STATE_KEYS array.
	// Filter out keys that are not part of ProviderSettings (global secrets are stored separately)
	const providerSecretKeys = SECRET_STATE_KEYS.filter((key) => !GLOBAL_SECRET_KEYS.includes(key as any))
	const hasSecretKey = providerSecretKeys.some((key) => config[key as keyof ProviderSettings] !== undefined)

	// Check additional non-secret configuration properties
	const hasOtherConfig = [
		config.awsRegion,
		config.vertexProjectId,
		config.ollamaModelId,
		config.lmStudioModelId,
		config.vsCodeLmModelSelector,
	].some((value) => value !== undefined)

	return hasSecretKey || hasOtherConfig
}
