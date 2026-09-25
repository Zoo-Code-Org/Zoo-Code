import { useEffect, useRef, useState } from "react"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	openAiModelInfoSaneDefaults,
	toCustomModelInfo,
	type CustomModelInfo,
	type ModelInfo,
	type ProviderSettings,
} from "@roo-code/types"

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

export const CustomModelInfoSettings = ({
	apiConfiguration,
	setApiConfigurationField,
	selectedModelInfo,
}: CustomModelInfoSettingsProps) => {
	const { t } = useAppTranslation()
	const override = apiConfiguration.customModelInfo
	const hasOverride = !!override

	// The stored value is a complete snapshot, so editing always starts from the
	// discovered catalog entry (or the shared sane defaults when the model is
	// unlisted). The editor never presents an empty field that silently resolves
	// to something else at request time.
	const seeded: CustomModelInfo = toCustomModelInfo(selectedModelInfo ?? openAiModelInfoSaneDefaults)
	// `openAiModelInfoSaneDefaults.maxTokens` is the `-1` "provider decides"
	// sentinel, which must not surface as a literal value in the editor.
	const baseline: CustomModelInfo = {
		...seeded,
		maxTokens: typeof seeded.maxTokens === "number" && seeded.maxTokens > 0 ? seeded.maxTokens : undefined,
	}
	const effective: CustomModelInfo = override ?? baseline

	const [isOpen, setIsOpen] = useState(!selectedModelInfo)
	const [contextWindowInput, setContextWindowInput] = useState(effective.contextWindow.toString())
	const [maxTokensInput, setMaxTokensInput] = useState(effective.maxTokens?.toString() ?? "")

	// Mirror externally changed values into the inputs. Comparing parsed text
	// against the stored value cannot distinguish "user typed invalid text" from
	// "no value stored" (both parse to undefined), so track what each input was
	// last synced from instead.
	const syncedContextWindow = useRef(effective.contextWindow)
	const syncedMaxTokens = useRef(effective.maxTokens)

	useEffect(() => {
		if (syncedContextWindow.current !== effective.contextWindow) {
			syncedContextWindow.current = effective.contextWindow
			setContextWindowInput(effective.contextWindow.toString())
		}
	}, [effective.contextWindow])

	useEffect(() => {
		if (syncedMaxTokens.current !== effective.maxTokens) {
			syncedMaxTokens.current = effective.maxTokens
			setMaxTokensInput(effective.maxTokens?.toString() ?? "")
		}
	}, [effective.maxTokens])

	useEffect(() => {
		if (!selectedModelInfo) {
			setIsOpen(true)
		}
	}, [selectedModelInfo])

	const commit = (patch: Partial<CustomModelInfo>) =>
		setApiConfigurationField("customModelInfo", { ...effective, ...patch })

	const handleContextWindowInput = (event: ValueChangeEvent) => {
		const target = event.target
		const value = target && "value" in target && typeof target.value === "string" ? target.value : ""
		setContextWindowInput(value)

		const parsed = parsePositiveInteger(value)

		// Context window is required for token accounting, so invalid or empty
		// text is kept on screen without persisting a broken snapshot.
		if (parsed !== undefined) {
			syncedContextWindow.current = parsed
			commit({ contextWindow: parsed })
		}
	}

	const handleMaxTokensInput = (event: ValueChangeEvent) => {
		const target = event.target
		const value = target && "value" in target && typeof target.value === "string" ? target.value : ""
		setMaxTokensInput(value)

		const parsed = parsePositiveInteger(value)

		// An empty field means "let the provider decide", which is a valid state.
		if (parsed !== undefined || value.trim() === "") {
			syncedMaxTokens.current = parsed
			commit({ maxTokens: parsed })
		}
	}

	const handleCapabilityChange = (field: "supportsImages" | "supportsPromptCache") => (event: ValueChangeEvent) => {
		const target = event.target
		const checked = target && "checked" in target && typeof target.checked === "boolean" ? target.checked : false
		commit({ [field]: checked })
	}

	const resetOverrides = () => {
		setContextWindowInput(baseline.contextWindow.toString())
		setMaxTokensInput(baseline.maxTokens?.toString() ?? "")
		syncedContextWindow.current = baseline.contextWindow
		syncedMaxTokens.current = baseline.maxTokens
		setApiConfigurationField("customModelInfo", undefined)
	}

	const contextWindowOverride = parsePositiveInteger(contextWindowInput)
	const maxTokensOverride = parsePositiveInteger(maxTokensInput)
	const hasInvalidContextWindow = contextWindowOverride === undefined
	const hasInvalidMaxTokens = maxTokensInput.trim().length > 0 && maxTokensOverride === undefined
	const hasInvalidRange =
		contextWindowOverride !== undefined &&
		maxTokensOverride !== undefined &&
		maxTokensOverride > contextWindowOverride

	const borderFor = (invalid: boolean) =>
		invalid ? "var(--vscode-inputValidation-errorBorder)" : "var(--vscode-input-border)"

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
								{t("settings:providers.customModel.contextWindow.label")}
							</label>
							<VSCodeTextField
								id="custom-context-window"
								value={contextWindowInput}
								onInput={handleContextWindowInput}
								style={{ borderColor: borderFor(hasInvalidContextWindow), width: "100%" }}
								aria-invalid={hasInvalidContextWindow}
								aria-describedby="custom-context-window-desc"
							/>
							<span id="custom-context-window-desc" className="text-xs text-vscode-descriptionForeground">
								{t("settings:providers.customModel.contextWindow.description")}
							</span>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="custom-max-tokens" className="text-sm font-medium">
								{t("settings:providers.customModel.maxTokens.label")}
							</label>
							<VSCodeTextField
								id="custom-max-tokens"
								value={maxTokensInput}
								onInput={handleMaxTokensInput}
								style={{ borderColor: borderFor(hasInvalidMaxTokens), width: "100%" }}
								aria-invalid={hasInvalidMaxTokens}
								aria-describedby="custom-max-tokens-desc"
							/>
							<span id="custom-max-tokens-desc" className="text-xs text-vscode-descriptionForeground">
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
							checked={effective.supportsImages ?? false}
							onChange={handleCapabilityChange("supportsImages")}>
							{t("settings:providers.customModel.imageSupport.label")}
						</VSCodeCheckbox>
						<span className="-mt-1 pl-5 text-xs text-vscode-descriptionForeground">
							{t("settings:providers.customModel.imageSupport.description")}
						</span>

						<VSCodeCheckbox
							checked={effective.supportsPromptCache}
							onChange={handleCapabilityChange("supportsPromptCache")}>
							{t("settings:providers.customModel.promptCache.label")}
						</VSCodeCheckbox>
						<span className="-mt-1 pl-5 text-xs text-vscode-descriptionForeground">
							{t("settings:providers.customModel.promptCache.description")}
						</span>
					</div>

					{hasOverride && (
						<Button type="button" variant="ghost" size="sm" onClick={resetOverrides} className="px-0">
							{t("settings:providers.customModel.resetDefaults")}
						</Button>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	)
}
