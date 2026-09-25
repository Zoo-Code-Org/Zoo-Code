import { useEffect, useRef, useState } from "react"
import {
	BedrockModelsMessageType,
	type BedrockCatalogEntry,
	type ExtensionMessage,
	type ProviderSettings,
} from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@src/i18n/TranslationContext"

export function BedrockCatalog({
	apiConfiguration,
	onSelect,
}: {
	apiConfiguration: ProviderSettings
	onSelect: (arn: string) => void
}) {
	const { t } = useAppTranslation()
	const [models, setModels] = useState<BedrockCatalogEntry[]>()
	const [error, setError] = useState(false)
	const [loading, setLoading] = useState(false)
	const requestId = useRef<string>()
	const { awsRegion, awsAccessKey, awsSecretKey, awsSessionToken, awsProfile, awsUseProfile, awsUseApiKey } =
		apiConfiguration
	useEffect(() => {
		requestId.current = undefined
		setModels(undefined)
		setLoading(false)
		setError(false)
		const listener = ({ data }: MessageEvent<ExtensionMessage>) => {
			if (
				data.type !== BedrockModelsMessageType.bedrockModels ||
				!requestId.current ||
				data.requestId !== requestId.current
			)
				return
			requestId.current = undefined
			setLoading(false)
			setError(!!data.error)
			setModels(data.error ? undefined : (data.bedrockModels ?? []))
		}
		window.addEventListener("message", listener)
		return () => {
			requestId.current = undefined
			window.removeEventListener("message", listener)
		}
	}, [awsRegion, awsAccessKey, awsSecretKey, awsSessionToken, awsProfile, awsUseProfile, awsUseApiKey])
	return (
		<div className="flex flex-col gap-2">
			<Button
				variant="secondary"
				disabled={loading || !awsRegion || awsUseApiKey}
				onClick={() => {
					requestId.current = crypto.randomUUID()
					setLoading(true)
					setError(false)
					setModels(undefined)
					vscode.postMessage({
						type: BedrockModelsMessageType.requestBedrockModels,
						requestId: requestId.current,
						apiConfiguration: {
							awsRegion,
							awsAccessKey,
							awsSecretKey,
							awsSessionToken,
							awsProfile,
							awsUseProfile,
							awsUseApiKey,
						},
					})
				}}>
				{t(loading ? "settings:providers.awsCatalogLoading" : "settings:providers.awsCatalogRefresh")}
			</Button>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.awsCatalogDescription")}
			</div>
			{error && (
				<div role="alert" className="text-sm text-vscode-errorForeground">
					{t("settings:providers.awsCatalogError")}
				</div>
			)}
			{models && (
				<>
					<label className="text-sm" htmlFor="bedrock-catalog">
						{t("settings:providers.awsCatalogSelect")}
					</label>
					<select
						id="bedrock-catalog"
						className="w-full min-w-0 bg-vscode-dropdown-background text-vscode-dropdown-foreground"
						value=""
						onChange={(event) => onSelect(event.target.value)}>
						<option value="" disabled>
							{t(models.length ? "settings:common.select" : "settings:providers.awsCatalogEmpty")}
						</option>
						{models.map((model) => (
							<option key={model.arn} value={model.arn}>
								{model.name} — {t(`settings:providers.awsCatalogKinds.${model.kind}`)}
							</option>
						))}
					</select>
				</>
			)}
		</div>
	)
}
