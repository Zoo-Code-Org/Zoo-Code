import { useCallback, useEffect, useMemo, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type BedrockDiscoveredTarget,
	type BedrockServiceTier,
	type ModelInfo,
	type ProviderSettings,
	BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS,
	BEDROCK_GLOBAL_INFERENCE_MODEL_IDS,
	BEDROCK_REGIONS,
	BEDROCK_SERVICE_TIER_MODEL_IDS,
	bedrockDefaultModelId,
	bedrockModels,
	expandBedrockTargetsWith1MVariants,
	inferBedrockInvokeTargetKind,
	parseBedrockBaseModelId,
} from "@roo-code/types"

import { useBedrockDiscovery } from "@src/components/ui/hooks/useBedrockDiscovery"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	Button,
	SearchableSelect,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StandardTooltip,
} from "@src/components/ui"

import { inputEventTransform, noTransform } from "../transforms"
import { BedrockCustomArn } from "./BedrockCustomArn"

type BedrockProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (
		field: keyof ProviderSettings,
		value: ProviderSettings[keyof ProviderSettings],
		isUserAction?: boolean,
	) => void
	selectedModelInfo?: ModelInfo
	simplifySettings?: boolean
}

const MANUAL_ARN_TARGET = "__bedrock_manual_arn__"

const renderTargetLabel = (target: BedrockDiscoveredTarget) => {
	const kindLabel =
		target.targetKind === "foundation-model"
			? "Direct model"
			: target.targetKind === "system-profile"
				? "System profile"
				: "Application profile"
	const contextLabel = target.contextWindow >= 1_000_000 ? "1M" : `${Math.round(target.contextWindow / 1000)}K`
	return `${target.label} [${kindLabel}, ${contextLabel}]`
}

export const Bedrock = ({ apiConfiguration, setApiConfigurationField, selectedModelInfo }: BedrockProps) => {
	const { t } = useAppTranslation()
	const [awsEndpointSelected, setAwsEndpointSelected] = useState(!!apiConfiguration?.awsBedrockEndpointEnabled)

	const {
		data: discoveredTargets = [],
		isLoading,
		isError,
		error,
		refetch,
		isFetching,
	} = useBedrockDiscovery(apiConfiguration, !!apiConfiguration.awsRegion)

	const selectedBaseModelId = useMemo(() => {
		if (apiConfiguration.apiModelId) {
			return parseBedrockBaseModelId(apiConfiguration.apiModelId)
		}
		if (apiConfiguration.awsBedrockInvokeTarget) {
			return parseBedrockBaseModelId(apiConfiguration.awsBedrockInvokeTarget)
		}
		if (apiConfiguration.awsCustomArn) {
			return parseBedrockBaseModelId(apiConfiguration.awsCustomArn)
		}
		return bedrockDefaultModelId
	}, [apiConfiguration.apiModelId, apiConfiguration.awsBedrockInvokeTarget, apiConfiguration.awsCustomArn])

	const selectedTargetKind = apiConfiguration.awsCustomArn
		? "custom-arn"
		: apiConfiguration.awsBedrockTargetKind ||
			inferBedrockInvokeTargetKind({
				targetId: apiConfiguration.awsBedrockInvokeTarget || apiConfiguration.apiModelId,
			})

	const isExplicitTargetSelection =
		selectedTargetKind === "system-profile" ||
		selectedTargetKind === "application-profile" ||
		selectedTargetKind === "custom-arn" ||
		selectedTargetKind === "prompt-router"

	const supportsOptIn1MContext =
		!!selectedBaseModelId &&
		BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS.includes(
			selectedBaseModelId as (typeof BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS)[number],
		)

	const supportsGlobalInference =
		!!selectedBaseModelId &&
		BEDROCK_GLOBAL_INFERENCE_MODEL_IDS.includes(
			selectedBaseModelId as (typeof BEDROCK_GLOBAL_INFERENCE_MODEL_IDS)[number],
		)

	const supportsServiceTiers =
		!!selectedBaseModelId &&
		BEDROCK_SERVICE_TIER_MODEL_IDS.includes(selectedBaseModelId as (typeof BEDROCK_SERVICE_TIER_MODEL_IDS)[number])

	const fallbackTargets = useMemo<BedrockDiscoveredTarget[]>(
		() =>
			expandBedrockTargetsWith1MVariants(
				Object.entries(bedrockModels).map(([modelId, modelInfo]) => {
					const typedModelInfo = modelInfo as ModelInfo
					return {
						id: modelId,
						label: typedModelInfo.description ? `${modelId} - ${typedModelInfo.description}` : modelId,
						baseModelId: modelId,
						targetKind: "foundation-model" as const,
						contextWindow: typedModelInfo.contextWindow,
						contextSource: "base" as const,
						description: typedModelInfo.description,
						supportsImages: typedModelInfo.supportsImages,
						supportsPromptCache: typedModelInfo.supportsPromptCache,
					}
				}),
			),
		[],
	)

	// Discovered targets from AWS may or may not include separate 1M profiles. Run them through
	// the same helper so the dropdown always offers both context-window variants side-by-side.
	const availableTargets = useMemo(() => {
		const base = discoveredTargets.length > 0 ? discoveredTargets : fallbackTargets
		return discoveredTargets.length > 0 ? expandBedrockTargetsWith1MVariants(base) : base
	}, [discoveredTargets, fallbackTargets])

	const selectedTargetValue =
		apiConfiguration.awsCustomArn || selectedTargetKind === "custom-arn"
			? MANUAL_ARN_TARGET
			: apiConfiguration.awsBedrockInvokeTarget || apiConfiguration.apiModelId || bedrockDefaultModelId

	const targetOptions = useMemo(() => {
		const options = availableTargets.map((target) => ({
			value: target.id,
			label: renderTargetLabel(target),
		}))

		if (
			selectedTargetValue &&
			selectedTargetValue !== MANUAL_ARN_TARGET &&
			!options.some((option) => option.value === selectedTargetValue)
		) {
			options.unshift({
				value: selectedTargetValue,
				label: `${selectedTargetValue} [Current target]`,
			})
		}

		options.push({
			value: MANUAL_ARN_TARGET,
			label: t("settings:labels.useCustomArn"),
		})

		return options
	}, [availableTargets, selectedTargetValue, t])

	useEffect(() => {
		setAwsEndpointSelected(!!apiConfiguration?.awsBedrockEndpointEnabled)
	}, [apiConfiguration?.awsBedrockEndpointEnabled])

	useEffect(() => {
		if (apiConfiguration.awsCustomArn) {
			const baseModelId = parseBedrockBaseModelId(apiConfiguration.awsCustomArn)

			if (apiConfiguration.awsBedrockInvokeTarget !== apiConfiguration.awsCustomArn) {
				setApiConfigurationField("awsBedrockInvokeTarget", apiConfiguration.awsCustomArn, false)
			}
			if (apiConfiguration.awsBedrockTargetKind !== "custom-arn") {
				setApiConfigurationField("awsBedrockTargetKind", "custom-arn", false)
			}
			if (baseModelId && apiConfiguration.apiModelId !== baseModelId) {
				setApiConfigurationField("apiModelId", baseModelId, false)
			}
			return
		}

		if (apiConfiguration.awsBedrockTargetKind === "custom-arn") {
			if (apiConfiguration.awsBedrockInvokeTarget) {
				setApiConfigurationField("awsBedrockInvokeTarget", "", false)
			}
			return
		}

		const legacyTarget = apiConfiguration.awsBedrockInvokeTarget || apiConfiguration.apiModelId
		if (!legacyTarget) {
			return
		}

		const inferredKind = inferBedrockInvokeTargetKind({ targetId: legacyTarget })
		const baseModelId = parseBedrockBaseModelId(legacyTarget)

		if (apiConfiguration.awsBedrockInvokeTarget !== legacyTarget) {
			setApiConfigurationField("awsBedrockInvokeTarget", legacyTarget, false)
		}
		if (apiConfiguration.awsBedrockTargetKind !== inferredKind) {
			setApiConfigurationField("awsBedrockTargetKind", inferredKind, false)
		}
		if (baseModelId && apiConfiguration.apiModelId !== baseModelId) {
			setApiConfigurationField("apiModelId", baseModelId, false)
		}
	}, [
		apiConfiguration.apiModelId,
		apiConfiguration.awsBedrockInvokeTarget,
		apiConfiguration.awsBedrockTargetKind,
		apiConfiguration.awsCustomArn,
		setApiConfigurationField,
	])

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

	const handleTargetChange = useCallback(
		(value: string) => {
			if (value === MANUAL_ARN_TARGET) {
				setApiConfigurationField("awsBedrockTargetKind", "custom-arn")
				setApiConfigurationField("awsBedrockInvokeTarget", apiConfiguration.awsCustomArn || "", false)
				return
			}

			const selectedTarget = availableTargets.find((target) => target.id === value)
			if (!selectedTarget) {
				return
			}

			setApiConfigurationField("awsCustomArn", "")
			setApiConfigurationField("awsBedrockInvokeTarget", selectedTarget.id)
			setApiConfigurationField("awsBedrockTargetKind", selectedTarget.targetKind)
			setApiConfigurationField("apiModelId", selectedTarget.baseModelId)
		},
		[apiConfiguration.awsCustomArn, availableTargets, setApiConfigurationField],
	)

	const handleCustomArnChange = useCallback(
		(event: Event) => {
			const value = (event.target as HTMLInputElement).value
			const baseModelId = parseBedrockBaseModelId(value)

			setApiConfigurationField("awsCustomArn", value)
			setApiConfigurationField("awsBedrockInvokeTarget", value, false)
			setApiConfigurationField("awsBedrockTargetKind", "custom-arn", false)
			if (baseModelId) {
				setApiConfigurationField("apiModelId", baseModelId, false)
			}
		},
		[setApiConfigurationField],
	)

	return (
		<>
			<div>
				<label className="block font-medium mb-1">Authentication Method</label>
				<Select
					value={
						apiConfiguration?.awsUseApiKey
							? "apikey"
							: apiConfiguration?.awsUseProfile
								? "profile"
								: "credentials"
					}
					onValueChange={(value) => {
						if (value === "apikey") {
							setApiConfigurationField("awsUseApiKey", true)
							setApiConfigurationField("awsUseProfile", false)
						} else if (value === "profile") {
							setApiConfigurationField("awsUseApiKey", false)
							setApiConfigurationField("awsUseProfile", true)
						} else {
							setApiConfigurationField("awsUseApiKey", false)
							setApiConfigurationField("awsUseProfile", false)
						}
					}}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="credentials">{t("settings:providers.awsCredentials")}</SelectItem>
						<SelectItem value="profile">{t("settings:providers.awsProfile")}</SelectItem>
						<SelectItem value="apikey">{t("settings:providers.awsApiKey")}</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="text-sm text-vscode-descriptionForeground -mt-3">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{apiConfiguration?.awsUseApiKey ? (
				<VSCodeTextField
					value={apiConfiguration?.awsApiKey || ""}
					type="password"
					onInput={handleInputChange("awsApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.awsApiKey")}</label>
				</VSCodeTextField>
			) : apiConfiguration?.awsUseProfile ? (
				<VSCodeTextField
					value={apiConfiguration?.awsProfile || ""}
					onInput={handleInputChange("awsProfile")}
					placeholder={t("settings:placeholders.profileName")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.awsProfileName")}</label>
				</VSCodeTextField>
			) : (
				<>
					<VSCodeTextField
						value={apiConfiguration?.awsAccessKey || ""}
						type="password"
						onInput={handleInputChange("awsAccessKey")}
						placeholder={t("settings:placeholders.accessKey")}
						className="w-full">
						<label className="block font-medium mb-1">{t("settings:providers.awsAccessKey")}</label>
					</VSCodeTextField>
					<VSCodeTextField
						value={apiConfiguration?.awsSecretKey || ""}
						type="password"
						onInput={handleInputChange("awsSecretKey")}
						placeholder={t("settings:placeholders.secretKey")}
						className="w-full">
						<label className="block font-medium mb-1">{t("settings:providers.awsSecretKey")}</label>
					</VSCodeTextField>
					<VSCodeTextField
						value={apiConfiguration?.awsSessionToken || ""}
						type="password"
						onInput={handleInputChange("awsSessionToken")}
						placeholder={t("settings:placeholders.sessionToken")}
						className="w-full">
						<label className="block font-medium mb-1">{t("settings:providers.awsSessionToken")}</label>
					</VSCodeTextField>
				</>
			)}
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.awsRegion")}</label>
				<Select
					value={apiConfiguration?.awsRegion || ""}
					onValueChange={(value) => setApiConfigurationField("awsRegion", value)}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						{BEDROCK_REGIONS.map(({ value, label }) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div>
				<div className="flex items-center justify-between gap-3 mb-1">
					<label className="block font-medium">Inference Target</label>
					<Button
						variant="outline"
						size="sm"
						type="button"
						onClick={() => refetch()}
						disabled={!apiConfiguration.awsRegion || isFetching}>
						{isFetching ? "Refreshing..." : "Refresh discovery"}
					</Button>
				</div>
				<SearchableSelect
					value={selectedTargetValue}
					onValueChange={handleTargetChange}
					options={targetOptions}
					placeholder="Choose a Bedrock model or profile"
					searchPlaceholder="Search models and profiles"
					emptyMessage="No Bedrock targets found"
					className="w-full"
					data-testid="bedrock-target-select"
					disabled={!apiConfiguration.awsRegion}
				/>
				<div className="text-sm text-vscode-descriptionForeground mt-1">
					{apiConfiguration.awsRegion
						? t("settings:providers.bedrock.discoveryDescription")
						: t("settings:providers.bedrock.discoveryDescriptionNoRegion")}
				</div>
				{isLoading && (
					<div className="text-sm text-vscode-descriptionForeground mt-1">Discovering Bedrock targets...</div>
				)}
				{isError && (
					<div className="text-sm text-vscode-errorForeground mt-1">
						Bedrock discovery failed: {error instanceof Error ? error.message : String(error)}
					</div>
				)}
			</div>
			{selectedTargetValue === MANUAL_ARN_TARGET && (
				<BedrockCustomArn
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					onInput={handleCustomArnChange}
				/>
			)}
			{supportsServiceTiers && (
				<div>
					<label className="block font-medium mb-1">{t("settings:providers.awsServiceTier")}</label>
					<Select
						value={apiConfiguration?.awsBedrockServiceTier || "STANDARD"}
						onValueChange={(value) =>
							setApiConfigurationField("awsBedrockServiceTier", value as BedrockServiceTier)
						}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder={t("settings:common.select")} />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="STANDARD">{t("settings:providers.awsServiceTierStandard")}</SelectItem>
							<SelectItem value="FLEX">{t("settings:providers.awsServiceTierFlex")}</SelectItem>
							<SelectItem value="PRIORITY">{t("settings:providers.awsServiceTierPriority")}</SelectItem>
						</SelectContent>
					</Select>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t("settings:providers.awsServiceTierNote")}
					</div>
				</div>
			)}
			{supportsGlobalInference && (
				<Checkbox
					checked={apiConfiguration?.awsUseGlobalInference || false}
					onChange={(checked: boolean) => {
						setApiConfigurationField("awsUseGlobalInference", checked)
					}}
					disabled={isExplicitTargetSelection}>
					{t("settings:providers.awsGlobalInference")}
				</Checkbox>
			)}
			<Checkbox
				checked={apiConfiguration?.awsUseCrossRegionInference || false}
				onChange={(checked: boolean) => {
					setApiConfigurationField("awsUseCrossRegionInference", checked)
				}}
				disabled={isExplicitTargetSelection}>
				{t("settings:providers.awsCrossRegion")}
			</Checkbox>
			{isExplicitTargetSelection && (
				<div className="text-sm text-vscode-descriptionForeground -mt-2">
					The selected target is already an explicit Bedrock profile/ARN, so additional global or cross-region
					routing settings are ignored.
				</div>
			)}
			{selectedModelInfo?.supportsPromptCache && (
				<>
					<Checkbox
						checked={apiConfiguration?.awsUsePromptCache ?? true}
						onChange={handleInputChange("awsUsePromptCache", noTransform)}>
						<div className="flex items-center gap-1">
							<span>{t("settings:providers.enablePromptCaching")}</span>
							<StandardTooltip content={t("settings:providers.enablePromptCachingTitle")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1">
						{t("settings:providers.cacheUsageNote")}
					</div>
				</>
			)}
			<Checkbox
				checked={apiConfiguration?.awsBedrockStructuredOutput ?? true}
				onChange={handleInputChange("awsBedrockStructuredOutput", noTransform)}>
				<div className="flex items-center gap-1">
					<span>{t("settings:providers.awsBedrockStructuredOutput")}</span>
					<StandardTooltip content={t("settings:providers.awsBedrockStructuredOutputTooltip")}>
						<i
							className="codicon codicon-info text-vscode-descriptionForeground"
							style={{ fontSize: "12px" }}
						/>
					</StandardTooltip>
				</div>
			</Checkbox>
			<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1">
				{t("settings:providers.awsBedrockStructuredOutputDescription")}
			</div>
			{supportsOptIn1MContext && (
				<div>
					<Checkbox
						checked={apiConfiguration?.awsBedrock1MContext ?? false}
						onChange={(checked: boolean) => {
							setApiConfigurationField("awsBedrock1MContext", checked)
						}}>
						{t("settings:providers.awsBedrock1MContextBetaLabel")}
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
						{t("settings:providers.awsBedrock1MContextBetaDescription")}
					</div>
				</div>
			)}
			<Checkbox
				checked={awsEndpointSelected}
				onChange={(isChecked) => {
					setAwsEndpointSelected(isChecked)
					setApiConfigurationField("awsBedrockEndpointEnabled", isChecked)
				}}>
				{t("settings:providers.awsBedrockVpc.useCustomVpcEndpoint")}
			</Checkbox>
			{awsEndpointSelected && (
				<>
					<VSCodeTextField
						value={apiConfiguration?.awsBedrockEndpoint || ""}
						style={{ width: "100%", marginTop: 3, marginBottom: 5 }}
						type="url"
						onInput={handleInputChange("awsBedrockEndpoint")}
						placeholder={t("settings:providers.awsBedrockVpc.vpcEndpointUrlPlaceholder")}
						data-testid="vpc-endpoint-input"
					/>
					<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1 mb-3">
						{t("settings:providers.awsBedrockVpc.examples")}
						<div className="ml-2">• https://vpce-xxx.bedrock.region.vpce.amazonaws.com/</div>
						<div className="ml-2">• https://gateway.my-company.com/route/app/bedrock</div>
					</div>
				</>
			)}
		</>
	)
}
