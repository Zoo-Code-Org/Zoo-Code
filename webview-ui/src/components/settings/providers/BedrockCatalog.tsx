import { useEffect, useRef, useState } from "react"
import {
	BedrockModelsMessageType,
	type BedrockCatalogEntry,
	type ExtensionMessage,
	type ProviderSettings,
} from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
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
			if (requestId.current) {
				vscode.postMessage({
					type: BedrockModelsMessageType.cancelBedrockModels,
					requestId: requestId.current,
				})
			}
			requestId.current = undefined
			window.removeEventListener("message", listener)
		}
	}, [awsRegion, awsAccessKey, awsSecretKey, awsSessionToken, awsProfile, awsUseProfile, awsUseApiKey])
	return (
		<div className="flex flex-col gap-2">
			<Button
				variant="secondary"
				disabled={loading || !awsRegion || awsUseApiKey || (!!awsUseProfile && !awsProfile?.trim())}
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
							...(awsUseProfile
								? { awsProfile, awsUseProfile: true }
								: { awsAccessKey, awsSecretKey, awsSessionToken, awsUseProfile: false }),
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
					{/* Empty value keeps the placeholder visible: picking an entry fills the custom ARN field. */}
					<Select value="" onValueChange={onSelect} disabled={!models.length}>
						<SelectTrigger id="bedrock-catalog" className="w-full">
							<SelectValue
								placeholder={t(
									models.length ? "settings:common.select" : "settings:providers.awsCatalogEmpty",
								)}
							/>
						</SelectTrigger>
						<SelectContent className="w-[var(--radix-select-trigger-width)]">
							{models.map((model) => (
								<SelectItem key={model.arn} value={model.arn} className="whitespace-normal break-words">
									{model.name} — {t(`settings:providers.awsCatalogKinds.${model.kind}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			)}
		</div>
	)
}
