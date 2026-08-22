import i18next from "i18next"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	getModelId,
	isDynamicProvider,
	parseOpenAiExtraBody,
	providerIdentifiers,
} from "@roo-code/types"

export function validateApiConfiguration(
	apiConfiguration: ProviderSettings,
	routerModels?: RouterModels,
	organizationAllowList?: OrganizationAllowList,
	zooCodeIsAuthenticated?: boolean,
): string | undefined {
	const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration, zooCodeIsAuthenticated)

	if (keysAndIdsPresentErrorMessage) {
		return keysAndIdsPresentErrorMessage
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	if (organizationAllowListError) {
		return organizationAllowListError.message
	}

	return validateDynamicProviderModelId(apiConfiguration, routerModels)
}

function validateModelsAndKeysProvided(
	apiConfiguration: ProviderSettings,
	zooCodeIsAuthenticated?: boolean,
): string | undefined {
	switch (apiConfiguration.apiProvider) {
		case providerIdentifiers.openrouter:
			if (!apiConfiguration.openRouterApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.requesty:
			if (!apiConfiguration.requestyApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.unbound:
			if (!apiConfiguration.unboundApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.litellm:
			if (!apiConfiguration.litellmApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.anthropic:
			if (!apiConfiguration.apiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.bedrock:
			if (!apiConfiguration.awsRegion) {
				return i18next.t("settings:validation.awsRegion")
			}
			break
		case providerIdentifiers.vertex:
			if (!apiConfiguration.vertexProjectId || !apiConfiguration.vertexRegion) {
				return i18next.t("settings:validation.googleCloud")
			}
			break
		case providerIdentifiers.gemini:
			if (!apiConfiguration.geminiApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.openaiNative:
			if (!apiConfiguration.openAiNativeApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.mistral:
			if (!apiConfiguration.mistralApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.openai:
			if (!apiConfiguration.openAiBaseUrl || !apiConfiguration.openAiApiKey || !apiConfiguration.openAiModelId) {
				return i18next.t("settings:validation.openAi")
			}
			break
		case providerIdentifiers.ollama:
			if (!apiConfiguration.ollamaModelId) {
				return i18next.t("settings:validation.modelId")
			}
			break
		case providerIdentifiers.lmstudio:
			if (!apiConfiguration.lmStudioModelId) {
				return i18next.t("settings:validation.modelId")
			}
			break
		case providerIdentifiers.vscodeLm:
			if (!apiConfiguration.vsCodeLmModelSelector) {
				return i18next.t("settings:validation.modelSelector")
			}
			break
		case providerIdentifiers.fireworks:
			if (!apiConfiguration.fireworksApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.friendli:
			if (!apiConfiguration.friendliApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.qwenCode:
			if (!apiConfiguration.qwenCodeOauthPath) {
				return i18next.t("settings:validation.qwenCodeOauthPath")
			}
			break
		case providerIdentifiers.kimiCode:
			if ((apiConfiguration.kimiCodeAuthMethod ?? "oauth") === "api-key" && !apiConfiguration.kimiCodeApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.vercelAiGateway:
			if (!apiConfiguration.vercelAiGatewayApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.opencodeGo:
			if (!apiConfiguration.opencodeGoApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.kenari:
			if (!apiConfiguration.kenariApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.nanogpt:
			if (!apiConfiguration.nanoGptApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
		case providerIdentifiers.zooGateway:
			if (!apiConfiguration.zooSessionToken && !zooCodeIsAuthenticated) {
				return i18next.t("settings:validation.zooGatewaySignIn")
			}
			break
		case providerIdentifiers.baseten:
			if (!apiConfiguration.basetenApiKey) {
				return i18next.t("settings:validation.apiKey")
			}
			break
	}

	return undefined
}

type ValidationError = {
	message: string
	code: "PROVIDER_NOT_ALLOWED" | "MODEL_NOT_ALLOWED"
}

function validateProviderAgainstOrganizationSettings(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): ValidationError | undefined {
	if (organizationAllowList && !organizationAllowList.allowAll) {
		const provider = apiConfiguration.apiProvider

		if (!provider) {
			return undefined
		}

		const providerConfig = organizationAllowList.providers[provider]

		if (!providerConfig) {
			return {
				message: i18next.t("settings:validation.providerNotAllowed", { provider }),
				code: "PROVIDER_NOT_ALLOWED",
			}
		}

		if (!providerConfig.allowAll) {
			const modelId = getModelId(apiConfiguration)
			const allowedModels = providerConfig.models || []

			if (modelId && !allowedModels.includes(modelId)) {
				return {
					message: i18next.t("settings:validation.modelNotAllowed", {
						model: modelId,
						provider,
					}),
					code: "MODEL_NOT_ALLOWED",
				}
			}
		}
	}
}

/**
 * Validates an Amazon Bedrock ARN and optionally checks if the region in
 * the ARN matches the provided region.
 *
 * Note: This function does not perform strict format validation on the ARN.
 * Users entering custom ARNs are advanced users who should be trusted to
 * provide valid ARNs without restriction. See issue #10108.
 *
 * @param arn The ARN string to validate
 * @param region Optional region to check against the ARN's region
 * @returns An object with validation results: { isValid, arnRegion, errorMessage }
 */
export function validateBedrockArn(arn: string, region?: string) {
	// Try to extract region from ARN for region mismatch warning.
	// This is a permissive regex that attempts to find the region component
	// without enforcing strict ARN format validation.
	const regionMatch = arn.match(/^arn:[^:]+:[^:]+:([^:]+):/)
	const arnRegion = regionMatch?.[1]

	// Check if region in ARN matches provided region (if specified).
	if (region && arnRegion && arnRegion !== region) {
		return {
			isValid: true,
			arnRegion,
			errorMessage: i18next.t("settings:validation.arn.regionMismatch", { arnRegion, region }),
		}
	}

	// ARN is always considered valid - trust the user to enter valid ARNs.
	return { isValid: true, arnRegion, errorMessage: undefined }
}

function validateDynamicProviderModelId(
	apiConfiguration: ProviderSettings,
	routerModels?: RouterModels,
): string | undefined {
	const provider = apiConfiguration.apiProvider ?? ""

	// We only validate model ids from dynamic providers.
	if (!isDynamicProvider(provider)) {
		return undefined
	}

	const modelId = getModelId(apiConfiguration)

	if (!modelId) {
		return i18next.t("settings:validation.modelId")
	}

	const models = routerModels?.[provider]

	if (models && Object.keys(models).length > 1 && !Object.keys(models).includes(modelId)) {
		return i18next.t("settings:validation.modelAvailability", { modelId })
	}

	return undefined
}

/**
 * Extracts model-specific validation errors from the API configuration.
 * This is used to show model errors specifically in the model selector components.
 */
export function getModelValidationError(
	apiConfiguration: ProviderSettings,
	routerModels?: RouterModels,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const modelId = getModelId(apiConfiguration) ?? apiConfiguration.apiModelId

	const configWithModelId = {
		...apiConfiguration,
		apiModelId: modelId || "",
	}

	const orgError = validateProviderAgainstOrganizationSettings(configWithModelId, organizationAllowList)

	if (orgError && orgError.code === "MODEL_NOT_ALLOWED") {
		return orgError.message
	}

	return validateDynamicProviderModelId(configWithModelId, routerModels)
}

/**
 * Validates API configuration but excludes model-specific errors.
 * This is used for the general API error display to prevent duplication
 * when model errors are shown in the model selector.
 *
 * Zoo Gateway's sign-in error is rendered inline by the `ZooGateway` provider
 * component, so we skip the keys/sign-in check here. Organization provider
 * restrictions still need to be enforced for zoo-gateway, so the org allowlist
 * check below runs for every provider.
 */
export function validateApiConfigurationExcludingModelErrors(
	apiConfiguration: ProviderSettings,
	_routerModels?: RouterModels, // Keeping this for compatibility with the old function.
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	if (apiConfiguration.apiProvider !== providerIdentifiers.zooGateway) {
		const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration)

		if (keysAndIdsPresentErrorMessage) {
			return keysAndIdsPresentErrorMessage
		}
	}

	if (apiConfiguration.apiProvider === providerIdentifiers.openai) {
		const extraBodyResult = parseOpenAiExtraBody(apiConfiguration.openAiExtraBody)
		if (!extraBodyResult.success) {
			if (extraBodyResult.reason === "reservedKeys") {
				return i18next.t("settings:validation.openAiExtraBody.reservedKeys", {
					keys: extraBodyResult.reservedKeys?.join(", ") ?? "",
				})
			}

			return i18next.t(`settings:validation.openAiExtraBody.${extraBodyResult.reason}`)
		}
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	// Only return organization errors if they're not model-specific.
	if (organizationAllowListError && organizationAllowListError.code === "PROVIDER_NOT_ALLOWED") {
		return organizationAllowListError.message
	}

	// Skip model validation errors as they'll be shown in the model selector.
	return undefined
}
