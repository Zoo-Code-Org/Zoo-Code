import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Check, X } from "lucide-react"

import { type ModelInfo, type OrganizationAllowList, type ProviderName } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
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
} from "@src/components/ui"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

import { filterModels } from "@/components/settings/utils/organizationFilters"

export interface ModelSelectProps {
	models: Record<string, ModelInfo> | null
	value: string
	onChange: (modelId: string) => void
	placeholder?: string
	disabled?: boolean
	isLoading?: boolean
	hideCustomModel?: boolean
	/** Provider used to apply organization allow-list filtering. */
	activeProvider?: ProviderName
	organizationAllowList?: OrganizationAllowList
	/** Extra classes for the popover content. */
	contentClassName?: string
	/** Portal container for the popover content. */
	portalContainer?: HTMLElement
	/** Optional tooltip shown above the trigger (wraps PopoverTrigger). */
	tooltip?: string
	/** Custom trigger renderer. */
	renderTrigger?: (args: {
		displayValue: string
		isLoading: boolean
		placeholder: string
		disabled: boolean
	}) => ReactNode
}

/**
 * Core model selection logic shared by the settings page and the chat input
 * bar: a Popover with a searchable Command list, ESC to close, search-state
 * cleanup, and an optional custom-model escape hatch.
 *
 * This component intentionally does **not** auto-initialize a default model,
 * nor does it write to configuration directly — callers own persistence.
 */
export const ModelSelect = ({
	models,
	value,
	onChange,
	placeholder,
	disabled = false,
	isLoading = false,
	hideCustomModel = false,
	activeProvider,
	organizationAllowList,
	contentClassName,
	portalContainer,
	tooltip,
	renderTrigger,
}: ModelSelectProps) => {
	const { t } = useAppTranslation()

	const [open, setOpen] = useState(false)
	const searchInputRef = useRef<HTMLInputElement>(null)
	const selectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const [searchValue, setSearchValue] = useState("")

	const displayValue = value ?? ""

	const modelIds = useMemo(() => {
		const filtered = filterModels(models, activeProvider, organizationAllowList)

		// Always include the currently selected model even if deprecated, but
		// filter out other deprecated models from being newly selectable.
		const available = Object.entries(filtered ?? {}).filter(([modelId, info]) =>
			modelId === displayValue ? true : !info.deprecated,
		)

		return available.map(([id]) => id).sort((a, b) => a.localeCompare(b))
	}, [models, activeProvider, organizationAllowList, displayValue])

	const onSelect = useCallback(
		(modelId: string) => {
			if (!modelId) return

			setOpen(false)
			onChange(modelId)

			if (selectTimeoutRef.current) clearTimeout(selectTimeoutRef.current)
			// Delay to ensure the popover is closed before clearing search.
			selectTimeoutRef.current = setTimeout(() => setSearchValue(""), 100)
		},
		[onChange],
	)

	const onOpenChange = useCallback((nextOpen: boolean) => {
		setOpen(nextOpen)
		// Abandon the current search when the popover closes.
		if (!nextOpen) {
			if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
			closeTimeoutRef.current = setTimeout(() => setSearchValue(""), 100)
		}
	}, [])

	const onClearSearch = useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	// Cleanup pending timeouts on unmount to prevent test flakiness.
	useEffect(() => {
		return () => {
			if (selectTimeoutRef.current) clearTimeout(selectTimeoutRef.current)
			if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
		}
	}, [])

	useEscapeKey(open, () => setOpen(false))

	const resolvedPlaceholder = placeholder ?? t("settings:common.select")

	const triggerNode = renderTrigger?.({
		displayValue,
		isLoading,
		placeholder: resolvedPlaceholder,
		disabled,
	})

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{tooltip ? (
				<StandardTooltip content={tooltip}>
					<PopoverTrigger asChild disabled={disabled}>
						{triggerNode}
					</PopoverTrigger>
				</StandardTooltip>
			) : (
				<PopoverTrigger asChild disabled={disabled}>
					{triggerNode}
				</PopoverTrigger>
			)}
			<PopoverContent
				className={cn(
					"p-0 w-[var(--radix-popover-trigger-width)]",
					// Compact (custom trigger) popovers anchor under the trigger;
					// default settings popovers keep the radix centred alignment.
					renderTrigger && "w-[300px]",
					contentClassName,
				)}
				container={portalContainer}
				align={renderTrigger ? "start" : undefined}
				sideOffset={renderTrigger ? 4 : undefined}>
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
		</Popover>
	)
}
