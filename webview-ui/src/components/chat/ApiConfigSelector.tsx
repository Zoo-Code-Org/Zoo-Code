import { useState, useMemo, useCallback, useEffect, type ReactNode } from "react"
import { Fzf } from "fzf"
import { Brain, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

import { IconButton } from "./IconButton"
import { PickerSearchField } from "./PickerSearchField"
import { handlePickerNavigation, pickerResultsClassName } from "./model-picker/pickerNavigation"

interface ApiConfigSelectorProps {
	value: string
	displayName: string
	modelId?: string
	reasoningEffort?: string
	quickSettings?: ReactNode
	disabled?: boolean
	title: string
	onChange: (value: string) => void
	triggerClassName?: string
	listApiConfigMeta: Array<{ id: string; name: string; modelId?: string }>
	pinnedApiConfigs?: Record<string, boolean>
	togglePinnedApiConfig: (id: string) => void
	lockApiConfigAcrossModes: boolean
	onToggleLockApiConfig: () => void
}

export const ApiConfigSelector = ({
	value,
	displayName,
	modelId,
	reasoningEffort,
	quickSettings,
	disabled = false,
	title,
	onChange,
	triggerClassName = "",
	listApiConfigMeta,
	pinnedApiConfigs,
	togglePinnedApiConfig,
	lockApiConfigAcrossModes,
	onToggleLockApiConfig,
}: ApiConfigSelectorProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const [showProfiles, setShowProfiles] = useState(false)
	const [pendingProfileId, setPendingProfileId] = useState<string | null>(null)
	const isProfileView = !quickSettings || showProfiles
	useEffect(() => {
		if (pendingProfileId === value) setPendingProfileId(null)
	}, [value, pendingProfileId])
	const portalContainer = useRooPortal("roo-portal")

	// Create searchable items for fuzzy search.
	const searchableItems = useMemo(
		() =>
			listApiConfigMeta.map((config) => ({
				original: config,
				searchStr: config.name,
			})),
		[listApiConfigMeta],
	)

	// Create Fzf instance.
	const fzfInstance = useMemo(
		() => new Fzf(searchableItems, { selector: (item) => item.searchStr }),
		[searchableItems],
	)

	// Filter configs based on search.
	const filteredConfigs = useMemo(() => {
		if (!searchValue) {
			return listApiConfigMeta
		}

		const matchingItems = fzfInstance.find(searchValue).map((result) => result.item.original)
		return matchingItems
	}, [listApiConfigMeta, searchValue, fzfInstance])

	// Separate pinned and unpinned configs.
	const { pinnedConfigs, unpinnedConfigs } = useMemo(() => {
		const pinned = filteredConfigs.filter((config) => pinnedApiConfigs?.[config.id])
		const unpinned = filteredConfigs.filter((config) => !pinnedApiConfigs?.[config.id])
		return { pinnedConfigs: pinned, unpinnedConfigs: unpinned }
	}, [filteredConfigs, pinnedApiConfigs])

	const handleSelect = useCallback(
		(configId: string) => {
			onChange(configId)
			if (quickSettings) {
				setPendingProfileId(configId === value ? null : configId)
				setShowProfiles(false)
			} else setOpen(false)
			setSearchValue("")
		},
		[onChange, quickSettings, value],
	)

	const handleEditClick = useCallback(() => {
		vscode.postMessage({ type: "switchTab", tab: "settings" })
		setOpen(false)
	}, [])

	const renderConfigItem = useCallback(
		(config: { id: string; name: string; modelId?: string }, isPinned: boolean) => {
			const isCurrentConfig = config.id === value

			return (
				<div
					key={config.id}
					className={cn(
						"px-3 py-1.5 text-sm cursor-pointer flex items-center group",
						"hover:bg-vscode-list-hoverBackground",
						isCurrentConfig &&
							"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
					)}>
					<button
						type="button"
						data-picker-result
						aria-pressed={isCurrentConfig}
						disabled={disabled}
						onClick={() => handleSelect(config.id)}
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 overflow-hidden border-none bg-transparent p-0 text-left text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
						<span className="flex-shrink-0">{config.name}</span>
						{config.modelId && (
							<>
								<span className="min-w-0 truncate text-vscode-descriptionForeground opacity-70">
									{config.modelId}
								</span>
							</>
						)}
					</button>
					<div className="flex items-center gap-1">
						{isCurrentConfig && (
							<div className="size-5 p-1 flex items-center justify-center">
								<span className="codicon codicon-check text-xs" />
							</div>
						)}
						<StandardTooltip content={isPinned ? t("chat:unpin") : t("chat:pin")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={isPinned ? t("chat:unpin") : t("chat:pin")}
								disabled={disabled}
								onClick={(e) => {
									e.stopPropagation()
									togglePinnedApiConfig(config.id)
									vscode.postMessage({ type: "toggleApiConfigPin", text: config.id })
								}}
								className={cn("size-5 flex items-center justify-center", {
									"opacity-0 group-hover:opacity-100": !isPinned && !isCurrentConfig,
									"bg-accent opacity-100": isPinned,
								})}>
								<span className="codicon codicon-pin text-xs opacity-50" />
							</Button>
						</StandardTooltip>
					</div>
				</div>
			)
		},
		[value, handleSelect, t, togglePinnedApiConfig, disabled],
	)

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen)
				if (!nextOpen) {
					setShowProfiles(false)
					setSearchValue("")
				}
			}}
			data-testid="api-config-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="dropdown-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						disabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
						triggerClassName,
					)}>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="truncate">
							<span className="opacity-70">{displayName}</span>
							{modelId && <> / {modelId}</>}
						</span>
						{reasoningEffort && reasoningEffort !== "disable" && (
							<span
								aria-label={t("chat:modelPicker.reasoningEffortValue", {
									effort: t(`chat:modelPicker.effort.${reasoningEffort}`),
								})}
								className="inline-flex shrink-0 items-center gap-1 rounded border border-vscode-input-border px-1 py-0.5 text-[10px] leading-none">
								<Brain aria-hidden="true" className="size-3" />
								{t(`chat:modelPicker.effort.${reasoningEffort}`)}
							</span>
						)}
					</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="flex max-h-[var(--radix-popover-content-available-height)] w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0">
				<div className="flex min-h-0 w-full flex-col">
					{quickSettings && (
						<button
							type="button"
							aria-label={t("chat:modelPicker.selectProfile")}
							aria-expanded={showProfiles}
							disabled={disabled}
							onClick={() => {
								setShowProfiles(!showProfiles)
								setSearchValue("")
							}}
							className="flex w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 border-none border-b border-solid border-vscode-dropdown-border bg-transparent px-3 py-2.5 text-left text-xs text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
							<span className="shrink-0 text-vscode-descriptionForeground">
								{t("chat:modelPicker.profile")}
							</span>
							<span className="min-w-0 flex-1 truncate font-semibold">{displayName}</span>
							<ChevronDown
								aria-hidden="true"
								className={cn("size-3 shrink-0 transition-transform", showProfiles && "rotate-180")}
							/>
						</button>
					)}
					<div className="flex min-h-0 flex-col overflow-y-auto" onKeyDown={handlePickerNavigation}>
						{!isProfileView &&
							(pendingProfileId && pendingProfileId !== value ? (
								<div
									role="status"
									className={cn(
										pickerResultsClassName,
										"p-3 text-xs text-vscode-descriptionForeground",
									)}>
									{t("chat:modelPicker.loadingProfile")}
								</div>
							) : (
								quickSettings
							))}
						{isProfileView && (
							<>
								{/* Search input or info blurb */}
								{quickSettings || listApiConfigMeta.length > 6 ? (
									<PickerSearchField
										label={t("common:ui.search_placeholder")}
										value={searchValue}
										onChange={setSearchValue}
										disabled={disabled}
									/>
								) : (
									<div className="p-3 border-b border-vscode-dropdown-border">
										<p className="text-xs text-vscode-descriptionForeground m-0">
											{t("prompts:apiConfiguration.select")}
										</p>
									</div>
								)}

								{/* Config list - single scroll container */}
								<div className={pickerResultsClassName}>
									{filteredConfigs.length === 0 ? (
										<div className="px-3 py-2 text-xs text-vscode-descriptionForeground">
											{t("common:ui.no_results")}
										</div>
									) : (
										<div>
											{/* Pinned configs - sticky header */}
											{pinnedConfigs.length > 0 && (
												<div
													className={cn(
														"sticky top-0 z-10 bg-vscode-dropdown-background py-1",
														unpinnedConfigs.length > 0 &&
															"border-b border-vscode-dropdown-foreground/10",
													)}
													aria-label="Pinned configurations">
													{pinnedConfigs.map((config) => renderConfigItem(config, true))}
												</div>
											)}

											{/* Unpinned configs */}
											{unpinnedConfigs.length > 0 && (
												<div className="py-1" aria-label="All configurations">
													{unpinnedConfigs.map((config) => renderConfigItem(config, false))}
												</div>
											)}
										</div>
									)}
								</div>
							</>
						)}
					</div>
					{/* Bottom bar with buttons on left and title on right */}
					<div className="flex shrink-0 flex-row items-center justify-between px-2 py-2 border-t border-vscode-dropdown-border">
						<div className="flex flex-row gap-1">
							<IconButton
								iconClass="codicon-settings-gear"
								title={t("chat:edit")}
								onClick={handleEditClick}
								tooltip={false}
							/>
							<IconButton
								iconClass={lockApiConfigAcrossModes ? "codicon-lock" : "codicon-unlock"}
								title={
									lockApiConfigAcrossModes
										? t("chat:unlockApiConfigAcrossModes")
										: t("chat:lockApiConfigAcrossModes")
								}
								className={lockApiConfigAcrossModes ? "text-vscode-focusBorder" : "opacity-60"}
								onClick={onToggleLockApiConfig}
							/>
						</div>

						{/* Info icon and title on the right with matching spacing */}
						<div className="flex items-center gap-1 pr-1">
							{listApiConfigMeta.length > 6 && (
								<StandardTooltip content={t("prompts:apiConfiguration.select")}>
									<span className="codicon codicon-info text-xs text-vscode-descriptionForeground opacity-70 hover:opacity-100 cursor-help" />
								</StandardTooltip>
							)}
							<h4 className="m-0 font-medium text-sm text-vscode-descriptionForeground">
								{t("prompts:apiConfiguration.title")}
							</h4>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
