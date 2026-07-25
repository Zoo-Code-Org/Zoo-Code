import { useEffect } from "react"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	kimiCodeDefaultModelId,
	kimiCodeModels,
	type KimiCodeAuthMethod,
	type ModelRecord,
	type ProviderSettings,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"

type KimiCodeProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	kimiCodeIsAuthenticated?: boolean
	kimiCodeOAuthState?: {
		status: "idle" | "authorizing" | "polling" | "authenticated" | "error"
		userCode?: string
		verificationUri?: string
		error?: string
	}
}

export const KimiCode = ({
	apiConfiguration,
	setApiConfigurationField,
	kimiCodeIsAuthenticated = false,
	kimiCodeOAuthState,
}: KimiCodeProps) => {
	const { t } = useAppTranslation()
	const authMethod = apiConfiguration.kimiCodeAuthMethod ?? "oauth"
	const { data, refetch, isFetching } = useRouterModels({
		provider: "kimi-code",
		enabled: authMethod === "oauth" ? kimiCodeIsAuthenticated : !!apiConfiguration.kimiCodeApiKey,
	})
	const discoveredModels = data?.["kimi-code"]
	const models: ModelRecord =
		discoveredModels && Object.keys(discoveredModels).length > 0 ? discoveredModels : kimiCodeModels

	useEffect(() => {
		if (authMethod === "oauth" && kimiCodeIsAuthenticated) void refetch()
	}, [authMethod, kimiCodeIsAuthenticated, refetch])

	const refreshModels = () => {
		vscode.postMessage({
			type: "requestRouterModels",
			values: {
				provider: "kimi-code",
				refresh: true,
				kimiCodeAuthMethod: authMethod,
				kimiCodeApiKey: apiConfiguration.kimiCodeApiKey,
			},
		})
		void refetch()
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.kimiCode.authMethod")}</label>
				<Select
					value={authMethod}
					onValueChange={(value) =>
						setApiConfigurationField("kimiCodeAuthMethod", value as KimiCodeAuthMethod)
					}>
					<SelectTrigger data-testid="kimi-code-auth-method">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="oauth">{t("settings:providers.kimiCode.oauth")}</SelectItem>
						<SelectItem value="api-key">{t("settings:providers.kimiCode.apiKey")}</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{authMethod === "oauth" ? (
				<div className="flex flex-col gap-2 rounded-md border border-vscode-panel-border p-3">
					{kimiCodeIsAuthenticated ? (
						<div className="flex items-center justify-between gap-2">
							<span className="text-vscode-descriptionForeground">
								{t("settings:providers.kimiCode.authenticated")}
							</span>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => vscode.postMessage({ type: "kimiCodeSignOut" })}>
								{t("settings:providers.kimiCode.signOut")}
							</Button>
						</div>
					) : (
						<Button className="w-fit" onClick={() => vscode.postMessage({ type: "kimiCodeSignIn" })}>
							{t("settings:providers.kimiCode.signIn")}
						</Button>
					)}
					{kimiCodeOAuthState?.status === "polling" && (
						<div className="text-sm" data-testid="kimi-code-device-code">
							<p className="m-0 text-vscode-descriptionForeground">
								{t("settings:providers.kimiCode.deviceCodeHelp")}
							</p>
							<code className="block my-2 text-lg font-semibold select-all">
								{kimiCodeOAuthState.userCode}
							</code>
							{kimiCodeOAuthState.verificationUri && (
								<VSCodeLink href={kimiCodeOAuthState.verificationUri}>
									{kimiCodeOAuthState.verificationUri}
								</VSCodeLink>
							)}
						</div>
					)}
					{kimiCodeOAuthState?.status === "error" && (
						<p className="m-0 text-vscode-errorForeground">{kimiCodeOAuthState.error}</p>
					)}
				</div>
			) : (
				<VSCodeTextField
					type="password"
					value={apiConfiguration.kimiCodeApiKey ?? ""}
					onInput={(event) =>
						setApiConfigurationField("kimiCodeApiKey", (event.target as HTMLInputElement).value)
					}
					className="w-full"
					data-testid="kimi-code-api-key">
					<label className="block font-medium mb-1">{t("settings:providers.kimiCode.apiKeyLabel")}</label>
				</VSCodeTextField>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={kimiCodeDefaultModelId}
				models={models}
				modelIdKey="apiModelId"
				serviceName="Kimi Code"
				serviceUrl="https://www.kimi.com/code"
				hidePricing
			/>
			<Button variant="secondary" size="sm" className="w-fit" disabled={isFetching} onClick={refreshModels}>
				{isFetching
					? t("settings:providers.refreshModels.loading")
					: t("settings:providers.refreshModels.label")}
			</Button>
			<VSCodeLink href="https://www.kimi.com/code">{t("settings:providers.kimiCode.docs")}</VSCodeLink>
		</div>
	)
}
