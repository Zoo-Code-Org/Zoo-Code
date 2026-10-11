import { useState, useCallback, useMemo } from "react"
import { useEvent } from "react-use"
import { LanguageModelChatSelector } from "vscode"
import { LoaderCircle, LogIn, RefreshCw, UserCog } from "lucide-react"

import {
	type ProviderSettings,
	type ExtensionMessage,
	type ModelInfo,
	VsCodeLmModelsMessageType,
	providerIdentifiers,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, StandardTooltip } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { useGitHubCopilotModels } from "@src/components/ui/hooks/useGitHubCopilotModels"

import { ModelPicker } from "../ModelPicker"

type VSCodeLMProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (
		field: keyof ProviderSettings,
		value: ProviderSettings[keyof ProviderSettings],
		isUserAction?: boolean,
	) => void
}

// A stable empty list: a fresh `[]` each render would defeat the memoization below.
const NO_MODELS: NonNullable<ExtensionMessage["vsCodeLmModels"]> = []

export const VSCodeLM = ({ apiConfiguration, setApiConfigurationField }: VSCodeLMProps) => {
	const { t } = useAppTranslation()
	const isCopilot = apiConfiguration.apiProvider === providerIdentifiers.githubCopilot

	// The legacy provider is fed by messages into local state; Copilot's list is the shared, extension-pushed one.
	const [legacyModels, setLegacyModels] = useState<NonNullable<ExtensionMessage["vsCodeLmModels"]>>([])
	const copilotModels = useGitHubCopilotModels(isCopilot)
	const vsCodeLmModels = (isCopilot ? copilotModels.data : legacyModels) ?? NO_MODELS
	const [isConnecting, setIsConnecting] = useState(false)
	const [isRefreshing, setIsRefreshing] = useState(false)
	const [error, setError] = useState<string>()
	const [account, setAccount] = useState<string>()
	const authenticationLabel = t(
		isConnecting
			? "settings:providers.githubCopilot.connecting"
			: account
				? "settings:providers.githubCopilot.reconnect"
				: "settings:providers.githubCopilot.signIn",
	)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			const expectedType = isCopilot
				? VsCodeLmModelsMessageType.githubCopilotModels
				: VsCodeLmModelsMessageType.vsCodeLmModels
			const isSignInResult = isCopilot && message.type === VsCodeLmModelsMessageType.githubCopilotSignInResult
			if (message.type !== expectedType && !isSignInResult) return

			if (message.type === expectedType && (message.vsCodeLmModels !== undefined || message.error)) {
				setIsRefreshing(false)
			}
			// A sign-in result supersedes any refresh still waiting, whose reply may have been discarded as stale.
			if (isSignInResult) {
				setIsConnecting(false)
				setIsRefreshing(false)
			}
			if (message.githubCopilotAccount !== undefined) setAccount(message.githubCopilotAccount ?? undefined)
			if (isSignInResult || message.error) setError(message.error)
			if (!isCopilot && !message.error && message.vsCodeLmModels) setLegacyModels(message.vsCodeLmModels)
		},
		[isCopilot],
	)

	useEvent("message", onMessage)

	// Convert VSCode LM models array to Record format for ModelPicker
	const modelsRecord = useMemo((): Record<string, ModelInfo> => {
		return vsCodeLmModels.reduce(
			(acc, model) => {
				const modelId = model.id ?? `${model.vendor}/${model.family}`
				acc[modelId] = {
					maxTokens: 0,
					contextWindow: model.maxInputTokens ?? 0,
					supportsPromptCache: false,
					displayName: model.name,
					description: `${model.vendor} - ${model.family}`,
					...model.modelInfo,
				}
				return acc
			},
			{} as Record<string, ModelInfo>,
		)
	}, [vsCodeLmModels])

	// Transform string model ID to { vendor, family } object for storage
	const valueTransform = useCallback(
		(modelId: string) => {
			const model = vsCodeLmModels.find((candidate) => candidate.id === modelId)
			if (model) {
				return {
					id: model.id,
					vendor: model.vendor,
					family: model.family,
					version: model.version,
				}
			}
			const [vendor, family] = modelId.split("/")
			return { vendor, family }
		},
		[vsCodeLmModels],
	)

	// Transform stored { vendor, family } object back to display string
	const displayTransform = useCallback(
		(value: unknown) => {
			if (!value) return ""
			const selector = value as LanguageModelChatSelector
			if (selector.id && vsCodeLmModels.some((model) => model.id === selector.id)) return selector.id
			const model = vsCodeLmModels.find(
				(candidate) => candidate.vendor === selector.vendor && candidate.family === selector.family,
			)
			if (model?.id) return model.id
			return selector.vendor && selector.family ? `${selector.vendor}/${selector.family}` : ""
		},
		[vsCodeLmModels],
	)

	return (
		<>
			{isCopilot && account && (
				<div role="status" className="text-sm text-vscode-descriptionForeground mb-2">
					{t("settings:providers.githubCopilot.signedIn", { account })}
				</div>
			)}
			{isCopilot && (
				<div
					role="group"
					aria-label={t("settings:providers.githubCopilot.accountActions")}
					className="flex flex-wrap items-center gap-1 mb-3">
					<StandardTooltip
						content={t(
							account
								? "settings:providers.githubCopilot.reconnect"
								: "settings:providers.githubCopilot.signIn",
						)}>
						<Button
							variant={account ? "ghost" : "secondary"}
							size={account ? "icon" : "sm"}
							aria-label={authenticationLabel}
							aria-busy={isConnecting}
							disabled={isConnecting || isRefreshing}
							onClick={() => {
								setIsConnecting(true)
								setError(undefined)
								vscode.postMessage({
									type: account
										? VsCodeLmModelsMessageType.githubCopilotReconnect
										: VsCodeLmModelsMessageType.githubCopilotSignIn,
								})
							}}>
							{isConnecting ? (
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							) : (
								<LogIn className="size-4" aria-hidden="true" />
							)}
							{!account && authenticationLabel}
						</Button>
					</StandardTooltip>
					<StandardTooltip content={t("settings:providers.refreshModels.label")}>
						<Button
							variant="ghost"
							size="icon"
							disabled={isConnecting || isRefreshing}
							aria-busy={isRefreshing}
							aria-label={t("settings:providers.refreshModels.label")}
							onClick={() => {
								setIsRefreshing(true)
								setError(undefined)
								vscode.postMessage({
									type: VsCodeLmModelsMessageType.requestVsCodeLmModels,
									apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
								})
							}}>
							<RefreshCw className={isRefreshing ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
						</Button>
					</StandardTooltip>
					{account && (
						<StandardTooltip content={t("settings:providers.githubCopilot.manageAccountDescription")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("settings:providers.githubCopilot.manageAccount")}
								disabled={isConnecting || isRefreshing}
								onClick={() =>
									vscode.postMessage({ type: VsCodeLmModelsMessageType.githubCopilotManageAccount })
								}>
								<UserCog className="size-4" aria-hidden="true" />
							</Button>
						</StandardTooltip>
					)}
				</div>
			)}
			{error && (
				<div role="alert" className="text-sm text-vscode-errorForeground mb-2">
					{error}
				</div>
			)}
			{vsCodeLmModels.length > 0 ? (
				<ModelPicker
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					defaultModelId=""
					models={modelsRecord}
					modelIdKey="vsCodeLmModelSelector"
					serviceName={isCopilot ? "GitHub Copilot" : "VS Code LM"}
					serviceUrl="https://code.visualstudio.com/api/extension-guides/language-model"
					valueTransform={valueTransform}
					displayTransform={displayTransform}
					hidePricing
				/>
			) : (
				<div>
					<label className="block font-medium mb-1">{t("settings:providers.vscodeLmModel")}</label>
					<div className="text-sm text-vscode-descriptionForeground">
						{t(
							isCopilot
								? "settings:providers.githubCopilot.noModels"
								: "settings:providers.vscodeLmDescription",
						)}
					</div>
				</div>
			)}
			<div className="text-sm text-vscode-errorForeground">{t("settings:providers.vscodeLmWarning")}</div>
		</>
	)
}
