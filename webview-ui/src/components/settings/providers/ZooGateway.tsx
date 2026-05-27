import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	zooGatewayDefaultModelId,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { getZooCodeAuthUrl } from "@src/oauth/urls"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import { ModelPicker } from "../ModelPicker"

type ZooGatewayProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
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

	return (
		<>
			{/* Zoo Code Authentication Section */}
			<div className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-2">
				<div className="flex items-center justify-between">
					<label className="block text-sm font-medium">{t("settings:providers.zooGateway.account")}</label>
					{zooCodeIsAuthenticated && zooCodeUserEmail && (
						<span className="text-xs text-vscode-descriptionForeground">{zooCodeUserEmail}</span>
					)}
				</div>
				{!zooCodeIsAuthenticated ? (
					<div className="flex flex-col gap-1">
						<p className="text-xs text-vscode-descriptionForeground">
							{t("settings:providers.zooGateway.signInDescription")}
						</p>
						<a
							href={authUrl}
							className="inline-flex w-fit items-center rounded-sm bg-vscode-button-background px-3 py-1 text-xs text-vscode-button-foreground no-underline hover:bg-vscode-button-hoverBackground">
							{t("settings:providers.zooGateway.signInButton")}
						</a>
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
				defaultModelId={zooGatewayDefaultModelId}
				models={routerModels?.["zoo-gateway"] ?? {}}
				modelIdKey="zooGatewayModelId"
				serviceName="Zoo Gateway"
				serviceUrl="https://www.zoocode.dev/dashboard/models"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
