import { t } from "../../i18n"

export const LEGACY_ROO_PROVIDER = "roo"

const ROUTER_REMOVAL_I18N_KEY = "common:errors.roo.routerRemoved"
const ROUTER_REMOVAL_DEFAULT_MESSAGE =
	"Roo Code Router has been removed. Please select and configure a different provider."

const ROUTER_SIGN_IN_UNAVAILABLE_I18N_KEY = "common:info.roo.signInUnavailable"
const ROUTER_SIGN_IN_UNAVAILABLE_DEFAULT_MESSAGE =
	"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue."

function getLocalizedMessage(key: string, defaultValue: string) {
	const translated = t(key, { defaultValue })
	return translated === key ? defaultValue : translated
}

export const getRouterRemovalMessage = () =>
	getLocalizedMessage(ROUTER_REMOVAL_I18N_KEY, ROUTER_REMOVAL_DEFAULT_MESSAGE)

export const getRouterUnavailableSignInMessage = () =>
	getLocalizedMessage(ROUTER_SIGN_IN_UNAVAILABLE_I18N_KEY, ROUTER_SIGN_IN_UNAVAILABLE_DEFAULT_MESSAGE)

export const ROUTER_REMOVAL_IMPORT_WARNING =
	"Roo Code Router was removed. The imported profile was downgraded and needs to be reconfigured."

type LegacyRooConfig = Record<string, unknown> & {
	apiProvider: typeof LEGACY_ROO_PROVIDER
}

export function isLegacyRooConfig(value: unknown): value is LegacyRooConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).apiProvider === LEGACY_ROO_PROVIDER
	)
}

export function downgradeLegacyRooConfig<T extends Record<string, unknown>>(
	config: T,
): { config: Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">; migrated: boolean } {
	if (!isLegacyRooConfig(config)) {
		return { config: config as Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">, migrated: false }
	}

	const { apiProvider: _apiProvider, apiModelId: _apiModelId, rooApiKey: _rooApiKey, ...rest } = config

	return {
		config: rest as Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">,
		migrated: true,
	}
}
