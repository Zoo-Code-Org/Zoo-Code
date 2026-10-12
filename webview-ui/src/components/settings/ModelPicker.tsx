import { useMemo, useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { ChevronsUpDown, Check, X, Info } from "lucide-react"

import {
	type ProviderName,
	type ProviderSettings,
	type ModelInfo,
	type OrganizationAllowList,
	isRetiredProvider,
	providerIdentifiers,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { filterModels } from "./utils/organizationFilters"
import { cn } from "@src/lib/utils"
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Popover,
	PopoverContent,
	PopoverTrigger,
	StandardTooltip,
	Button,
} from "@src/components/ui"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

import { ModelInfoView } from "./ModelInfoView"
import { ApiErrorMessage } from "./ApiErrorMessage"

type ModelIdKey = keyof Pick<
	ProviderSettings,
	| "openRouterModelId"
	| "requestyModelId"
	| "unboundModelId"
	| "openAiModelId"
	| "litellmModelId"
	| "vercelAiGatewayModelId"
	| "opencodeGoModelId"
	| "kenariModelId"
	| "nanoGptModelId"
	| "zooGatewayModelId"
	| "apiModelId"
	| "ollamaModelId"
	| "lmStudioModelId"
	| "lmStudioDraftModelId"
	| "vsCodeLmModelSelector"
>

interface ModelPickerProps {
	defaultModelId: string
	models: Record<string, ModelInfo> | null
	modelIdKey: ModelIdKey
	serviceName: string
	serviceUrl: string
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	organizationAllowList?: OrganizationAllowList
	errorMessage?: string
	simplifySettings?: boolean
	hidePricing?: boolean
	/** Label for the model picker field - defaults to "Model" */
	label?: string
	/** Transform model ID string to the value stored in configuration (for compound types like VSCodeLM selector) */
	valueTransform?: (modelId: string) => unknown
	/** Transform stored configuration value back to display string */
	displayTransform?: (value: unknown) => string
	/** Callback when model changes - useful for side effects like clearing related fields */
	onModelChange?: (modelId: string) => void
	/**
	 * Compact mode for the chat input bar: renders `renderTrigger` instead of
	 * the labelled combobox button, hides the model info/pricing block, and
	 * never auto-initializes a default model (the chat selector only reflects
	 * the active profile and persists explicit selections).
	 */
	compact?: boolean
	/** Tooltip content shown above the trigger (compact mode). */
	tooltip?: string
	/** Disable the trigger (compact mode). */
	disabled?: boolean
	/** Whether the model list is still loading (compact mode). */
	isLoading?: boolean
	/** Hide the custom-model escape hatch even when free-form ids are allowed. */
	hideCustomModel?: boolean
	/** Custom trigger renderer (compact mode). */
	renderTrigger?: (state: {
		displayValue: string | undefined
		placeholder: string
		isLoading: boolean
		disabled: boolean
	}) => ReactNode
	/** Extra classes for the popover content (compact mode). */
	contentClassName?: string
	/** Portal container for the popover content (compact mode). */
	portalContainer?: HTMLElement
	/**
	 * Provider used to filter the model list. Defaults to the provider on
	 * `apiConfiguration`; the chat selector overrides it for an unset provider.
	 */
	activeProviderOverride?: ProviderName
}

export const ModelPicker = ({
	defaultModelId,
	models,
	modelIdKey,
	serviceName,
	serviceUrl,
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	errorMessage,
	simplifySettings,
	hidePricing,
	label,
	valueTransform,
	displayTransform,
	onModelChange,
	compact = false,
	tooltip,
	disabled = false,
	isLoading = false,
	hideCustomModel = false,
	renderTrigger,
	contentClassName,
	portalContainer,
	activeProviderOverride,
}: ModelPickerProps) => {
	const { t } = useAppTranslation()

	const [open, setOpen] = useState(false)
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false)
	const isInitialized = useRef(false)
	const searchInputRef = useRef<HTMLInputElement>(null)
	const selectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null)

	const { id: selectedModelId, info: selectedModelInfo } = useSelectedModel(apiConfiguration)

	// Get the display value for the current selection
	// If displayTransform is provided, use it to convert the stored value to a display string
	const displayValue = useMemo(() => {
		if (displayTransform) {
			const storedValue = apiConfiguration[modelIdKey]
			return storedValue ? displayTransform(storedValue) : undefined
		}
		return selectedModelId
	}, [displayTransform, apiConfiguration, modelIdKey, selectedModelId])

	const activeProvider =
		activeProviderOverride ??
		(apiConfiguration.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)
			? undefined
			: apiConfiguration.apiProvider)

	const modelIds = useMemo(() => {
		const filteredModels = filterModels(models, activeProvider, organizationAllowList)

		// Include the currently selected model even if deprecated (so users can see what they have selected)
		// But filter out other deprecated models from being newly selectable
		const availableModels = Object.entries(filteredModels ?? {})
			.filter(([modelId, modelInfo]) => {
				// Always include the currently selected model
				if (modelId === selectedModelId) return true
				// Filter out deprecated models that aren't currently selected
				return !modelInfo.deprecated
			})
			.reduce(
				(acc, [modelId, modelInfo]) => {
					acc[modelId] = modelInfo
					return acc
				},
				{} as Record<string, ModelInfo>,
			)

		return Object.keys(availableModels).sort((a, b) => a.localeCompare(b))
	}, [models, activeProvider, organizationAllowList, selectedModelId])

	const [searchValue, setSearchValue] = useState("")

	const onSelect = useCallback(
		(modelId: string) => {
			if (!modelId) {
				return
			}

			setOpen(false)

			// Apply value transform if provided (e.g., for VSCodeLM selector)
			const valueToStore = valueTransform ? valueTransform(modelId) : modelId
			setApiConfigurationField(modelIdKey, valueToStore as ProviderSettings[ModelIdKey])

			// Call the optional change callback
			onModelChange?.(modelId)

			// Clear any existing timeout
			if (selectTimeoutRef.current) {
				clearTimeout(selectTimeoutRef.current)
			}

			// Delay to ensure the popover is closed before setting the search value.
			selectTimeoutRef.current = setTimeout(() => setSearchValue(""), 100)
		},
		[modelIdKey, setApiConfigurationField, valueTransform, onModelChange],
	)

	const onOpenChange = useCallback((open: boolean) => {
		setOpen(open)

		// Abandon the current search if the popover is closed.
		if (!open) {
			// Clear any existing timeout
			if (closeTimeoutRef.current) {
				clearTimeout(closeTimeoutRef.current)
			}

			// Clear the search value when closing instead of prefilling it
			closeTimeoutRef.current = setTimeout(() => setSearchValue(""), 100)
		}
	}, [])

	const onClearSearch = useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	useEffect(() => {
		// The compact (chat) picker must never auto-write configuration on mount.
		if (compact) {
			isInitialized.current = true
			return
		}

		if (!selectedModelId && !isInitialized.current) {
			const initialValue = modelIds.includes(selectedModelId) ? selectedModelId : defaultModelId
			setApiConfigurationField(modelIdKey, initialValue, false) // false = automatic initialization
		}

		isInitialized.current = true
	}, [modelIds, setApiConfigurationField, modelIdKey, selectedModelId, defaultModelId, compact])

	// Cleanup timeouts on unmount to prevent test flakiness
	useEffect(() => {
		return () => {
			if (selectTimeoutRef.current) {
				clearTimeout(selectTimeoutRef.current)
			}
			if (closeTimeoutRef.current) {
				clearTimeout(closeTimeoutRef.current)
			}
		}
	}, [])

	// Use the shared ESC key handler hook
	useEscapeKey(open, () => setOpen(false))

	// Popover body shared by the settings picker and the compact chat picker.
	const popoverContent = (
		<PopoverContent
			className={cn("p-0 w-[var(--radix-popover-trigger-width)]", compact && "w-[300px]", contentClassName)}
			container={portalContainer}
			align={compact ? "start" : undefined}
			sideOffset={compact ? 4 : undefined}>
			<Command>
				<div className="relative">
					<CommandInput
						ref={searchInputRef}
						value={searchValue}
						onValueChange={setSearchValue}
						placeholder={t("settings:modelPicker.searchPlaceholder")}
						className="h-9 mr-4"
						data-testid="model-input"
					/>
					{searchValue.length > 0 && (
						<div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
							<X
								className="text-vscode-input-foreground opacity-50 hover:opacity-100 size-4 p-0.5 cursor-pointer"
								onClick={onClearSearch}
							/>
						</div>
					)}
				</div>
				<CommandList>
					<CommandEmpty>
						{searchValue && (
							<div className="py-2 px-1 text-sm">{t("settings:modelPicker.noMatchFound")}</div>
						)}
					</CommandEmpty>
					<CommandGroup>
						{modelIds.map((model) => (
							<CommandItem
								key={model}
								value={model}
								onSelect={onSelect}
								data-testid={`model-option-${model}`}>
								<span className="truncate" title={model}>
									{model}
								</span>
								<Check
									className={cn(
										"size-4 p-0.5 ml-auto",
										model === displayValue ? "opacity-100" : "opacity-0",
									)}
								/>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
				{!hideCustomModel && searchValue && !modelIds.includes(searchValue) && (
					<div className="p-1 border-t border-vscode-input-border">
						<CommandItem data-testid="use-custom-model" value={searchValue} onSelect={onSelect}>
							{t("settings:modelPicker.useCustomModel", { modelId: searchValue })}
						</CommandItem>
					</div>
				)}
			</Command>
		</PopoverContent>
	)

	if (compact) {
		const trigger = renderTrigger?.({
			displayValue,
			placeholder: t("settings:common.select"),
			isLoading,
			disabled,
		})

		return (
			<Popover open={open} onOpenChange={onOpenChange}>
				{tooltip ? (
					<StandardTooltip content={tooltip}>
						<PopoverTrigger asChild disabled={disabled}>
							{trigger}
						</PopoverTrigger>
					</StandardTooltip>
				) : (
					<PopoverTrigger asChild disabled={disabled}>
						{trigger}
					</PopoverTrigger>
				)}
				{popoverContent}
			</Popover>
		)
	}

	return (
		<>
			<div>
				<label className="block font-medium mb-1">{label ?? t("settings:modelPicker.label")}</label>
				<Popover open={open} onOpenChange={onOpenChange}>
					<PopoverTrigger asChild>
						<Button
							variant="combobox"
							role="combobox"
							aria-expanded={open}
							className="w-full justify-between"
							data-testid="model-picker-button">
							<div className="truncate">{displayValue ?? t("settings:common.select")}</div>
							<ChevronsUpDown className="opacity-50" />
						</Button>
					</PopoverTrigger>
					{popoverContent}
				</Popover>
			</div>
			{errorMessage && <ApiErrorMessage errorMessage={errorMessage} />}
			{selectedModelInfo?.deprecated && (
				<ApiErrorMessage errorMessage={t("settings:validation.modelDeprecated")} />
			)}

			{simplifySettings ? (
				<p className="text-xs text-vscode-descriptionForeground m-0">
					<Info className="size-3 inline mr-1" />
					{t("settings:modelPicker.simplifiedExplanation")}
				</p>
			) : (
				<div>
					{selectedModelId && selectedModelInfo && !selectedModelInfo.deprecated && (
						<ModelInfoView
							apiProvider={apiConfiguration.apiProvider}
							selectedModelId={selectedModelId}
							modelInfo={selectedModelInfo}
							isDescriptionExpanded={isDescriptionExpanded}
							setIsDescriptionExpanded={setIsDescriptionExpanded}
							hidePricing={hidePricing}
						/>
					)}
					{!hidePricing && apiConfiguration.apiProvider !== providerIdentifiers.mimo && (
						<div className="text-sm text-vscode-descriptionForeground" data-testid="automatic-fetch-hint">
							<Trans
								i18nKey="settings:modelPicker.automaticFetch"
								components={{
									serviceLink: <VSCodeLink href={serviceUrl} className="text-sm" />,
									defaultModelLink: (
										<VSCodeLink onClick={() => onSelect(defaultModelId)} className="text-sm" />
									),
								}}
								values={{ serviceName, defaultModelId }}
							/>
						</div>
					)}
				</div>
			)}
		</>
	)
}
