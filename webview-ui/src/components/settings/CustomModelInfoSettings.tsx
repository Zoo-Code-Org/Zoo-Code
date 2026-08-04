import { useEffect, useState } from "react"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { type CustomModelInfo, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

type CustomModelInfoSettingsProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: "customModelInfo", value: ProviderSettings["customModelInfo"]) => void
	selectedModelInfo?: ModelInfo
}

type ValueChangeEvent = {
	target: EventTarget | null
}

const parsePositiveInteger = (value: string): number | undefined => {
	const normalized = value.trim()

	if (!/^\d+$/.test(normalized)) {
		return undefined
	}

	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const getEventValue = (event: ValueChangeEvent): string => {
	const target = event.target

	if (target && "value" in target && typeof target.value === "string") {
		return target.value
	}

	return ""
}

const getCheckboxValue = (event: ValueChangeEvent): boolean => {
	const target = event.target

	if (target && "checked" in target && typeof target.checked === "boolean") {
		return target.checked
	}

	return false
}

const getInputBorderColor = (value: string): string | undefined => {
	if (!value.trim()) {
		return undefined
	}

	return parsePositiveInteger(value)
		? "var(--vscode-testing-iconPassed)"
		: "var(--vscode-inputValidation-errorBorder)"
}

export const CustomModelInfoSettings = ({
	apiConfiguration,
	setApiConfigurationField,
	selectedModelInfo,
}: CustomModelInfoSettingsProps) => {
	const { t } = useAppTranslation()
	const [isOpen, setIsOpen] = useState(!selectedModelInfo)
	const [contextWindowInput, setContextWindowInput] = useState(
		apiConfiguration.customModelInfo?.contextWindow?.toString() ?? "",
	)
	const [maxTokensInput, setMaxTokensInput] = useState(apiConfiguration.customModelInfo?.maxTokens?.toString() ?? "")

	const configuredContextWindow = apiConfiguration.customModelInfo?.contextWindow
	const configuredMaxTokens = apiConfiguration.customModelInfo?.maxTokens
	const customModelInfo = apiConfiguration.customModelInfo ?? {}

	useEffect(() => {
		if (parsePositiveInteger(contextWindowInput) !== configuredContextWindow) {
			setContextWindowInput(configuredContextWindow?.toString() ?? "")
		}
	}, [configuredContextWindow, contextWindowInput])

	useEffect(() => {
		if (parsePositiveInteger(maxTokensInput) !== configuredMaxTokens) {
			setMaxTokensInput(configuredMaxTokens?.toString() ?? "")
		}
	}, [configuredMaxTokens, maxTokensInput])

	useEffect(() => {
		if (!selectedModelInfo) {
			setIsOpen(true)
		}
	}, [selectedModelInfo])

	const updateOverride = <K extends keyof CustomModelInfo>(field: K, value: CustomModelInfo[K] | undefined) => {
		const next: CustomModelInfo = { ...customModelInfo }

		if (value === undefined) {
			delete next[field]
		} else {
			next[field] = value
		}

		setApiConfigurationField("customModelInfo", Object.keys(next).length > 0 ? next : undefined)
	}

	const handleContextWindowInput = (event: ValueChangeEvent) => {
		const value = getEventValue(event)
		setContextWindowInput(value)
		updateOverride("contextWindow", parsePositiveInteger(value))
	}

	const handleMaxTokensInput = (event: ValueChangeEvent) => {
		const value = getEventValue(event)
		setMaxTokensInput(value)
		updateOverride("maxTokens", parsePositiveInteger(value))
	}

	const resetOverrides = () => {
		setContextWindowInput("")
		setMaxTokensInput("")
		setApiConfigurationField("customModelInfo", undefined)
	}

	const supportsImages = customModelInfo.supportsImages ?? selectedModelInfo?.supportsImages ?? false
	const supportsPromptCache = customModelInfo.supportsPromptCache ?? selectedModelInfo?.supportsPromptCache ?? false
	const contextWindowOverride = parsePositiveInteger(contextWindowInput)
	const maxTokensOverride = parsePositiveInteger(maxTokensInput)
	const hasInvalidContextWindow = contextWindowInput.trim().length > 0 && contextWindowOverride === undefined
	const hasInvalidMaxTokens = maxTokensInput.trim().length > 0 && maxTokensOverride === undefined
	const hasInvalidRange =
		contextWindowOverride !== undefined &&
		maxTokensOverride !== undefined &&
		maxTokensOverride > contextWindowOverride

	return (
		<div className="mt-3 border-t border-vscode-panel-border pt-3">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CollapsibleTrigger className="flex w-full items-center gap-1 text-left text-sm font-medium hover:opacity-80">
					<span className={`codicon codicon-chevron-${isOpen ? "down" : "right"}`} />
					<span>{t("settings:providers.customModelInfo.title")}</span>
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-3 pt-2">
					<p className="text-xs text-vscode-descriptionForeground">
						{selectedModelInfo
							? t("settings:providers.customModelInfo.description")
							: t("settings:providers.customModelInfo.unresolved")}
					</p>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<div className="flex flex-col gap-1">
							<label htmlFor="custom-context-window" className="text-sm font-medium">
								{t("settings:providers.customModelInfo.contextWindow.label")}
							</label>
							<VSCodeTextField
								id="custom-context-window"
								value={contextWindowInput}
								onInput={handleContextWindowInput}
								placeholder={selectedModelInfo?.contextWindow?.toString() ?? "0"}
								style={{ borderColor: getInputBorderColor(contextWindowInput), width: "100%" }}
								aria-invalid={hasInvalidContextWindow}
							/>
							<span className="text-xs text-vscode-descriptionForeground">
								{t("settings:providers.customModelInfo.contextWindow.description")}
							</span>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="custom-max-tokens" className="text-sm font-medium">
								{t("settings:providers.customModelInfo.maxTokens.label")}
							</label>
							<VSCodeTextField
								id="custom-max-tokens"
								value={maxTokensInput}
								onInput={handleMaxTokensInput}
								placeholder={selectedModelInfo?.maxTokens?.toString() ?? "0"}
								style={{ borderColor: getInputBorderColor(maxTokensInput), width: "100%" }}
								aria-invalid={hasInvalidMaxTokens}
							/>
							<span className="text-xs text-vscode-descriptionForeground">
								{t("settings:providers.customModelInfo.maxTokens.description")}
							</span>
						</div>
					</div>

					{hasInvalidRange && (
						<p className="text-xs text-vscode-errorForeground">
							{t("settings:providers.customModelInfo.maxTokensWarning")}
						</p>
					)}

					<div className="flex flex-col gap-2">
						<VSCodeCheckbox
							checked={supportsImages}
							onChange={(event) => updateOverride("supportsImages", getCheckboxValue(event))}>
							{t("settings:providers.customModelInfo.supportsImages.label")}
						</VSCodeCheckbox>
						<span className="-mt-1 pl-5 text-xs text-vscode-descriptionForeground">
							{t("settings:providers.customModelInfo.supportsImages.description")}
						</span>

						<VSCodeCheckbox
							checked={supportsPromptCache}
							onChange={(event) => updateOverride("supportsPromptCache", getCheckboxValue(event))}>
							{t("settings:providers.customModelInfo.supportsPromptCache.label")}
						</VSCodeCheckbox>
						<span className="-mt-1 pl-5 text-xs text-vscode-descriptionForeground">
							{t("settings:providers.customModelInfo.supportsPromptCache.description")}
						</span>
					</div>

					<Button type="button" variant="ghost" size="sm" onClick={resetOverrides} className="px-0">
						{t("settings:providers.customModelInfo.reset")}
					</Button>
				</CollapsibleContent>
			</Collapsible>
		</div>
	)
}
