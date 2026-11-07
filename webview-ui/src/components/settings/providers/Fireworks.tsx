import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"
import { useDebounce } from "react-use"

import {
	type ModelRecord,
	type OrganizationAllowList,
	type ProviderSettings,
	type ExtensionMessage,
	type RouterModels,
	fireworksDefaultModelId,
	providerIdentifiers,
	allRouterModelsProvider,
	RouterModelsMessageType,
} from "@roo-code/types"

import { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"
import { ModelPicker } from "../ModelPicker"
import { handleModelChangeSideEffects } from "../utils/providerModelConfig"

import { inputEventTransform } from "../transforms"

type FireworksProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList?: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

/**
 * A token that is unique to this page load. A webview reload resets this module, so a
 * counter alone would let the new page reuse an identifier that a request still in flight
 * from the previous page carries; the extension would then treat both as the same request
 * and publish the older response.
 */
function createPageToken(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID()
	}

	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const fireworksRequestPageToken = createPageToken()

// Module-scoped so identifiers stay unique across component instances: a remount must not
// reuse an identifier that an in-flight request from the previous instance still carries.
let fireworksRouterModelsRequestCount = 0

/** Exported for tests that assert identifiers stay unique across a module reload. */
export const nextFireworksRouterModelsRequestId = () => {
	fireworksRouterModelsRequestCount += 1
	return `fireworks-router-models-${fireworksRequestPageToken}-${fireworksRouterModelsRequestCount}`
}

/** A catalog known for one API key, used when a failed refresh would empty the picker. */
type RetainedCatalog = {
	apiKey?: string
	models: ModelRecord
}

export const Fireworks = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: FireworksProps) => {
	const { t } = useAppTranslation()
	const { routerModels } = useExtensionState()
	const queryClient = useQueryClient()
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const fireworksApiKey = apiConfiguration.fireworksApiKey
	const fireworksErrorJustReceived = useRef(false)
	// Identifies the Fireworks request this component is waiting on. Responses echo it so an
	// older request that finishes last cannot overwrite the catalog of the newer key.
	const currentRequestId = useRef<string | undefined>(undefined)
	// The last catalog known for a key. The picker renders extension state, which a failed
	// same-key refresh replaces with an empty catalog, so this is the fallback that keeps the
	// list populated. A failed refresh may keep it only while the key is unchanged; a
	// different key must clear it.
	const retainedCatalogRef = useRef<RetainedCatalog | undefined>(undefined)
	const [retainedCatalog, setRetainedCatalog] = useState<RetainedCatalog | undefined>(undefined)

	const rememberCatalog = useCallback((apiKey: string | undefined, models: ModelRecord) => {
		const current = retainedCatalogRef.current
		if (current && current.apiKey === apiKey && current.models === models) {
			return
		}

		const retained = { apiKey, models }
		retainedCatalogRef.current = retained
		setRetainedCatalog(retained)
	}, [])

	// Extension state is the picker's source, so remember what it holds for the current key.
	// A later failure can then restore the list even when the backend has no cache entry.
	// Extension state still describes the saved key right after an edit, so a catalog that
	// was already there cannot be attributed to the newly typed key: only a catalog that
	// arrives while the key is stable belongs to that key.
	const observedExtensionCatalog = useRef<{ apiKey?: string; models?: ModelRecord }>({
		apiKey: fireworksApiKey,
	})

	useEffect(() => {
		const models = routerModels?.[providerIdentifiers.fireworks]
		const previous = observedExtensionCatalog.current
		const keyChanged = previous.apiKey !== fireworksApiKey
		const modelsArrived = previous.models !== models
		observedExtensionCatalog.current = { apiKey: fireworksApiKey, models }

		if (keyChanged || !modelsArrived || !models || Object.keys(models).length === 0) {
			return
		}

		rememberCatalog(fireworksApiKey, models)
	}, [routerModels, fireworksApiKey, rememberCatalog])

	const nextRequestId = useCallback(() => {
		const requestId = nextFireworksRouterModelsRequestId()
		currentRequestId.current = requestId
		return requestId
	}, [])

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			// A response without an identifier cannot be attributed to this component's
			// request, and a mismatched one belongs to a superseded request.
			const isCurrentRequest = message.requestId !== undefined && message.requestId === currentRequestId.current

			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (
					providerName === providerIdentifiers.fireworks &&
					refreshStatus === RefreshStatus.Loading &&
					isCurrentRequest
				) {
					fireworksErrorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				// Aggregate responses carry no provider and may belong to an unrelated
				// request, so only a Fireworks-scoped response can complete this refresh.
				if ((message.values?.provider as RouterName | undefined) !== providerIdentifiers.fireworks) {
					return
				}

				// Two key-specific requests can overlap. Accepting an older response that
				// arrives last would replace the newer key's catalog, leaving the picker
				// listing models the saved key cannot use.
				if (!isCurrentRequest) {
					return
				}

				const incoming = message.routerModels

				if (incoming) {
					// A failed fetch publishes an empty catalog. Keep the last catalog when it was
					// loaded with the same key, so a transient failure does not empty the picker.
					// A different key must clear it: the previous account's models may not be
					// usable with the edited key.
					const sameKeyCatalog = retainedCatalogRef.current?.apiKey === fireworksApiKey
					const models = incoming[providerIdentifiers.fireworks]
					const catalog = models && Object.keys(models).length > 0 ? models : sameKeyCatalog ? undefined : {}

					if (catalog) {
						rememberCatalog(fireworksApiKey, catalog)
						// Write the explicit-key catalog straight into the query cache. Invalidating
						// these keys would refetch with the saved key and could replace the catalog
						// of the account the user just refreshed.
						queryClient.setQueryData<RouterModels>(
							[RouterModelsMessageType.routerModels, providerIdentifiers.fireworks],
							(current) =>
								current ? { ...current, [providerIdentifiers.fireworks]: catalog } : incoming,
						)
						// The aggregate entry holds every provider, so only merge into an existing
						// one: creating it from this partial payload would hide the other providers.
						queryClient.setQueryData<RouterModels>(
							[RouterModelsMessageType.routerModels, allRouterModelsProvider],
							(current) =>
								current ? { ...current, [providerIdentifiers.fireworks]: catalog } : undefined,
						)
					}
				}

				if (refreshStatus === RefreshStatus.Loading && !fireworksErrorJustReceived.current) {
					setRefreshStatus(RefreshStatus.Success)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [refreshStatus, queryClient, fireworksApiKey, rememberCatalog])

	// A profile switch leaves the previous key's catalog in extension state. Request the
	// catalog with the new key so the picker cannot show or persist models that key cannot
	// use. The initial mount is skipped: the shared router-model query already loads the
	// saved key's catalog, and re-requesting here would flush that cache on every mount.
	// Debounced so typing a key does not fire one request per keystroke.
	const previousApiKey = useRef(fireworksApiKey)

	useDebounce(
		() => {
			const keyChanged = previousApiKey.current !== fireworksApiKey
			previousApiKey.current = fireworksApiKey

			if (!keyChanged || !fireworksApiKey) {
				return
			}

			// The key-change request supersedes any refresh in flight, so that refresh's
			// response is discarded. Restart the status for the new request: a stale error
			// would otherwise stay visible, and a superseded refresh would leave the status
			// stuck on loading.
			fireworksErrorJustReceived.current = false
			setRefreshStatus(RefreshStatus.Loading)
			setRefreshError(undefined)

			vscode.postMessage({
				type: RouterModelsMessageType.requestRouterModels,
				requestId: nextRequestId(),
				values: { provider: providerIdentifiers.fireworks, fireworksApiKey },
			})
		},
		250,
		[fireworksApiKey, nextRequestId],
	)

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const handleRefreshModels = useCallback(() => {
		fireworksErrorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)

		const key = apiConfiguration.fireworksApiKey

		if (!key) {
			setRefreshStatus(RefreshStatus.Error)
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			requestId: nextRequestId(),
			values: {
				provider: providerIdentifiers.fireworks,
				fireworksApiKey: key,
			},
		})
	}, [apiConfiguration, nextRequestId, t])

	// The picker renders extension state, not the query cache. A failed same-key refresh
	// publishes an empty catalog there, so fall back to the last catalog known for the
	// current key. Without a key nothing can be fetched, so show nothing: the previous
	// account's models must not stay selectable.
	const extensionModels = routerModels?.[providerIdentifiers.fireworks]
	const retainedModels =
		retainedCatalog && retainedCatalog.apiKey === fireworksApiKey ? retainedCatalog.models : undefined
	const models = !fireworksApiKey
		? {}
		: extensionModels && Object.keys(extensionModels).length > 0
			? extensionModels
			: (retainedModels ?? {})

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.fireworksApiKey || ""}
				type="password"
				onInput={handleInputChange("fireworksApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.fireworksApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.fireworksApiKey && (
				<VSCodeButtonLink href="https://fireworks.ai/" appearance="secondary">
					{t("settings:providers.getFireworksApiKey")}
				</VSCodeButtonLink>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={fireworksDefaultModelId}
				models={models}
				modelIdKey="apiModelId"
				serviceName="Fireworks AI"
				serviceUrl="https://fireworks.ai/models"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
				onModelChange={(modelId) =>
					handleModelChangeSideEffects(providerIdentifiers.fireworks, modelId, setApiConfigurationField)
				}
			/>
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === RefreshStatus.Loading || !apiConfiguration.fireworksApiKey}>
				<div className="flex items-center gap-2">
					{refreshStatus === RefreshStatus.Loading ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			{refreshStatus === RefreshStatus.Loading && (
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.refreshModels.loading")}
				</div>
			)}
			{refreshStatus === RefreshStatus.Success && (
				<div className="text-sm text-vscode-foreground">{t("settings:providers.refreshModels.success")}</div>
			)}
			{refreshStatus === RefreshStatus.Error && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || t("settings:providers.refreshModels.error")}
				</div>
			)}
		</>
	)
}
