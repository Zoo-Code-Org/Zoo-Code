import { useCallback, useMemo } from "react"
import { Trans } from "react-i18next"
import { Checkbox } from "vscrui"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, VERTEX_REGIONS, VERTEX_1M_CONTEXT_MODEL_IDS } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { inputEventTransform } from "../transforms"

// Detects when the "Google Cloud Credentials" field has received a filesystem
// path instead of the raw JSON contents of a service-account key file. Mirrors
// the runtime guard in src/api/providers/gemini.ts so the warning the user
// sees in the UI matches what the runtime would log.
function looksLikeFilePath(value: string): boolean {
	const trimmed = value.trim()
	if (!trimmed) {
		return false
	}
	return (
		/^[A-Za-z]:[\\/]/.test(trimmed) || // Windows: C:\... or C:/...
		trimmed.startsWith("/") || // POSIX absolute: /home/...
		trimmed.startsWith("~") || // POSIX home: ~/...
		trimmed.startsWith(".") // POSIX relative: ./... or ../...
	)
}

type VertexProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Vertex = ({ apiConfiguration, setApiConfigurationField }: VertexProps) => {
	const { t } = useAppTranslation()

	// Check if the selected model supports 1M context (supported Claude 4 models)
	const supports1MContextBeta =
		!!apiConfiguration?.apiModelId &&
		VERTEX_1M_CONTEXT_MODEL_IDS.includes(
			apiConfiguration.apiModelId as (typeof VERTEX_1M_CONTEXT_MODEL_IDS)[number],
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

	const credentialsLooksLikePath = useMemo(
		() => looksLikeFilePath(apiConfiguration?.vertexJsonCredentials ?? ""),
		[apiConfiguration?.vertexJsonCredentials],
	)

	return (
		<>
			<div className="text-sm text-vscode-descriptionForeground">
				<div>{t("settings:providers.googleCloudSetup.title")}</div>
				<div>
					<VSCodeLink
						href="https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#before_you_begin"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step1")}
					</VSCodeLink>
				</div>
				<div>
					<VSCodeLink
						href="https://cloud.google.com/docs/authentication/provide-credentials-adc#google-idp"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step2")}
					</VSCodeLink>
				</div>
				<div>
					<VSCodeLink
						href="https://developers.google.com/workspace/guides/create-credentials?hl=en#service-account"
						className="text-sm">
						{t("settings:providers.googleCloudSetup.step3")}
					</VSCodeLink>
				</div>
			</div>
			<VSCodeTextField
				value={apiConfiguration?.vertexJsonCredentials || ""}
				onInput={handleInputChange("vertexJsonCredentials")}
				placeholder={t("settings:placeholders.credentialsJson")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudCredentials")}</label>
			</VSCodeTextField>
			{credentialsLooksLikePath && (
				<div
					data-testid="vertex-credentials-path-warning"
					role="alert"
					aria-live="polite"
					className="text-sm text-vscode-errorForeground">
					<Trans
						i18nKey="settings:providers.googleCloudCredentialsPathWarning"
						components={{
							strong: <strong />,
							code: <code />,
						}}
					/>
				</div>
			)}
			<VSCodeTextField
				value={apiConfiguration?.vertexKeyFile || ""}
				onInput={handleInputChange("vertexKeyFile")}
				placeholder={t("settings:placeholders.keyFilePath")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudKeyFile")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.vertexProjectId || ""}
				onInput={handleInputChange("vertexProjectId")}
				placeholder={t("settings:placeholders.projectId")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudProjectId")}</label>
			</VSCodeTextField>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.googleCloudRegion")}</label>
				<Select
					value={apiConfiguration?.vertexRegion || ""}
					onValueChange={(value) => setApiConfigurationField("vertexRegion", value)}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						{VERTEX_REGIONS.map(({ value, label }) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{supports1MContextBeta && (
				<div>
					<Checkbox
						data-testid="checkbox-vertex-1m-context"
						checked={apiConfiguration?.vertex1MContext ?? false}
						onChange={(checked: boolean) => {
							setApiConfigurationField("vertex1MContext", checked)
						}}>
						{t("settings:providers.vertex1MContextBetaLabel")}
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
						{t("settings:providers.vertex1MContextBetaDescription")}
					</div>
				</div>
			)}
		</>
	)
}
