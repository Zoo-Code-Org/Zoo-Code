import { useEffect, useMemo } from "react"
import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	zooGatewayDefaultModelId,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { getZooCodeAuthUrl } from "@src/oauth/urls"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { ModelPicker } from "../ModelPicker"
import { ApiErrorMessage } from "../ApiErrorMessage"

type ZooGatewayProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

function isClaudeSonnetModelId(id: string) {
	return /claude.*sonnet/i.test(id)
}

// Exported for unit tests. Picks the default Zoo Gateway model id, preferring
// Claude Sonnet 4.5 → Sonnet 4 → first available Sonnet → first model overall.
export function pickZooGatewayDefaultModelId(modelIds: string[]) {
	if (modelIds.length === 0) {
		return zooGatewayDefaultModelId
	}

	const sonnets = modelIds.filter(isClaudeSonnetModelId)
	if (sonnets.length === 0) {
		return modelIds[0]
	}

	return (
		sonnets.find((id) => id === "anthropic/claude-sonnet-4.5") ??
		sonnets.find((id) => id.includes("claude-sonnet-4.5")) ??
		sonnets.find((id) => /sonnet-4[.-]5/i.test(id)) ??
		sonnets.find((id) => /sonnet-4(?![.-]?\d)/i.test(id)) ??
		sonnets[0]
	)
}

export const ZooGateway = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: ZooGatewayProps) => {
	const { t } = useAppTranslation()
	const { zooCodeIsAuthenticated, zooCodeUserEmail, zooCodeUserName, zooCodeBaseUrl, uriScheme, deviceName } =
		useExtensionState()

	const authUrl = getZooCodeAuthUrl(uriScheme, zooCodeBaseUrl, deviceName)
	const resolvedDashboardBase = zooCodeBaseUrl?.replace(/\/$/, "") || "https://www.zoocode.dev"

	const zooModels = useMemo(() => routerModels?.["zoo-gateway"] ?? {}, [routerModels])
	const modelIds = useMemo(() => Object.keys(zooModels), [zooModels])
	const resolvedDefaultModelId = useMemo(() => pickZooGatewayDefaultModelId(modelIds), [modelIds])

	useEffect(() => {
		if (modelIds.length === 0) {
			return
		}

		const current = apiConfiguration.zooGatewayModelId
		if (!current || !modelIds.includes(current)) {
			setApiConfigurationField("zooGatewayModelId", resolvedDefaultModelId)
		}
	}, [apiConfiguration.zooGatewayModelId, modelIds, resolvedDefaultModelId, setApiConfigurationField])

	return (
		<>
			<div className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-2">
				<div className="flex items-center justify-between">
					<label className="block text-sm font-medium">{t("settings:providers.zooGateway.account")}</label>
					{zooCodeIsAuthenticated && zooCodeUserEmail && (
						<span className="text-xs text-vscode-descriptionForeground">{zooCodeUserEmail}</span>
					)}
				</div>
				{!zooCodeIsAuthenticated ? (
					<div className="flex flex-col gap-1">
						<ApiErrorMessage errorMessage={t("settings:validation.zooGatewaySignIn")} />
						<p className="text-xs text-vscode-descriptionForeground">
							{t("settings:providers.zooGateway.signInDescription")}
						</p>
						<VSCodeButtonLink href={authUrl} appearance="primary">
							{t("settings:providers.zooGateway.signInButton")}
						</VSCodeButtonLink>
					</div>
				) : (
					<div className="flex items-center gap-1">
						<span className="codicon codicon-check text-vscode-charts-green" />
						<span className="text-xs text-vscode-descriptionForeground">
							{zooCodeUserName
								? t("settings:providers.zooGateway.authenticatedAs", { name: zooCodeUserName })
								: t("settings:providers.zooGateway.authenticated")}
						</span>
					</div>
				)}
			</div>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={resolvedDefaultModelId}
				models={zooModels}
				modelIdKey="zooGatewayModelId"
				serviceName="Zoo Gateway"
				serviceUrl={`${resolvedDashboardBase}/dashboard/models`}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
