import { FormEvent, HTMLAttributes, useEffect } from "react"
import React from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"
import { ListChevronsDownUp } from "lucide-react"
import { DEFAULT_DIFF_FUZZY_THRESHOLD } from "@roo-code/types"

import { supportPrompt } from "@roo/support-prompt"

import { cn } from "@/lib/utils"
import {
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
	Button,
	StandardTooltip,
} from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { useSearchIndexContext } from "./useSettingsSearch"

type ContextManagementSettingsProps = HTMLAttributes<HTMLDivElement> & {
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	idleCondenseContext: boolean
	idleCondenseContextPercent: number
	idleCondenseTimeInSeconds: number
	listApiConfigMeta: any[]
	maxOpenTabsContext: number
	maxWorkspaceFiles: number
	showRooIgnoredFiles?: boolean
	enableSubfolderRules?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
	profileThresholds?: Record<string, number>
	profileIdleThresholds?: Record<string, number>
	profileIdleCondenseTimes?: Record<string, number>
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	writeDelayMs: number
	diffFuzzyThreshold?: number
	includeCurrentTime?: boolean
	includeCurrentCost?: boolean
	maxGitStatusFiles?: number
	customSupportPrompts: Record<string, string | undefined>
	setCustomSupportPrompts: (prompts: Record<string, string | undefined>) => void
	setCachedStateField: SetCachedStateField<
		| "autoCondenseContext"
		| "autoCondenseContextPercent"
		| "idleCondenseContext"
		| "idleCondenseContextPercent"
		| "idleCondenseTimeInSeconds"
		| "profileIdleThresholds"
		| "profileIdleCondenseTimes"
		| "maxOpenTabsContext"
		| "maxWorkspaceFiles"
		| "showRooIgnoredFiles"
		| "enableSubfolderRules"
		| "maxImageFileSize"
		| "maxTotalImageSize"
		| "profileThresholds"
		| "includeDiagnosticMessages"
		| "maxDiagnosticMessages"
		| "writeDelayMs"
		| "diffFuzzyThreshold"
		| "includeCurrentTime"
		| "includeCurrentCost"
		| "maxGitStatusFiles"
	>
}

// The toolkit checkbox delivers change events retargeted to its custom-element host, which mirrors
// `checked` without being an HTMLInputElement; a directly rendered input is one. Match on the
// property so both target shapes update the setting, and decline targets that carry no boolean
// `checked` rather than writing `undefined` through the guard.
const isCheckboxTarget = (target: EventTarget | null): target is EventTarget & { checked: boolean } =>
	target !== null && "checked" in target && typeof target.checked === "boolean"

export const ContextManagementSettings = ({
	autoCondenseContext,
	autoCondenseContextPercent,
	idleCondenseContext,
	idleCondenseContextPercent,
	idleCondenseTimeInSeconds,
	listApiConfigMeta,
	maxOpenTabsContext,
	maxWorkspaceFiles,
	showRooIgnoredFiles,
	enableSubfolderRules,
	setCachedStateField,
	maxImageFileSize,
	maxTotalImageSize,
	profileThresholds = {},
	profileIdleThresholds = {},
	profileIdleCondenseTimes = {},
	includeDiagnosticMessages,
	maxDiagnosticMessages,
	writeDelayMs,
	diffFuzzyThreshold,
	includeCurrentTime,
	includeCurrentCost,
	maxGitStatusFiles,
	customSupportPrompts,
	setCustomSupportPrompts,
	className,
	...props
}: ContextManagementSettingsProps) => {
	const { t } = useAppTranslation()
	const [selectedThresholdProfile, setSelectedThresholdProfile] = React.useState<string>("default")
	const [selectedIdleProfile, setSelectedIdleProfile] = React.useState<string>("default")

	const idleTimeLabel = t("settings:contextManagement.idleCondensing.idleTime.label")

	// Settings search indexes each tab once during an initial cycling phase,
	// before the user has a chance to enable idle condensing. The idle time
	// control only renders when idle condensing is enabled, so registering it
	// only through the rendered SearchableSetting would leave "Idle time"
	// unsearchable whenever the feature starts out disabled. Register the
	// label unconditionally here (like SearchableSetting, we never unregister)
	// so the result is always in the index; the rendered control below still
	// carries the matching data-setting-id for navigation when it is visible.
	const searchContext = useSearchIndexContext()
	useEffect(() => {
		if (searchContext) {
			searchContext.registerSetting({
				settingId: "context-idle-time",
				section: "contextManagement",
				label: idleTimeLabel,
			})
		}
	}, [searchContext, idleTimeLabel])

	// Helper function to get the CONDENSE prompt value
	const getCondensePromptValue = (): string => {
		return supportPrompt.get(customSupportPrompts, "CONDENSE")
	}

	// Helper function to update the CONDENSE prompt
	const updateCondensePrompt = (value: string | undefined) => {
		const updatedPrompts = { ...customSupportPrompts }
		if (value === undefined) {
			delete updatedPrompts["CONDENSE"]
		} else {
			updatedPrompts["CONDENSE"] = value
		}
		setCustomSupportPrompts(updatedPrompts)
	}

	// Helper function to reset the CONDENSE prompt to default
	const handleCondenseReset = () => {
		const updatedPrompts = { ...customSupportPrompts }
		delete updatedPrompts["CONDENSE"]
		setCustomSupportPrompts(updatedPrompts)
	}

	// Mirrors computeEffectiveCondenseThreshold in src/core/context-management
	// (and the MIN/MAX_CONDENSE_THRESHOLD constants in src/core/condense, which
	// the webview cannot import): -1/undefined inherit the global value, a value
	// inside [5, 100] overrides it, and anything else (e.g. an invalid imported
	// override) falls back to the global value, exactly as the runtime does.
	const MIN_CONDENSE_THRESHOLD = 5
	const MAX_CONDENSE_THRESHOLD = 100
	const resolveCondensePercent = (globalPercent: number, profileValue: number | undefined): number => {
		if (profileValue === undefined || profileValue === -1) {
			return globalPercent
		}
		if (profileValue >= MIN_CONDENSE_THRESHOLD && profileValue <= MAX_CONDENSE_THRESHOLD) {
			return profileValue
		}
		return globalPercent
	}

	// Helper function to get the current threshold value based on selected profile
	const getCurrentThresholdValue = () => {
		if (selectedThresholdProfile === "default") {
			return autoCondenseContextPercent
		}
		return resolveCondensePercent(autoCondenseContextPercent, profileThresholds[selectedThresholdProfile])
	}

	// Lowering the condensing trigger threshold lowers the current idle thresholds
	// that inherit from it, so the idle threshold never exceeds the trigger
	// threshold. The idle slider's max stays at 100%.
	const clampIdleToTrigger = (newValue: number) => {
		if (idleCondenseContextPercent > newValue) {
			setCachedStateField("idleCondenseContextPercent", newValue)
		}
		const clampedProfileIdleThresholds = { ...profileIdleThresholds }
		let changed = false
		for (const [id, idleValue] of Object.entries(profileIdleThresholds)) {
			if (idleValue === -1) {
				continue
			}
			const profileTrigger = profileThresholds[id]
			// Only profile idle overrides that inherit the default trigger threshold follow this change.
			if (profileTrigger !== undefined && profileTrigger !== -1) {
				continue
			}
			if (idleValue > newValue) {
				clampedProfileIdleThresholds[id] = newValue
				changed = true
			}
		}
		if (changed) {
			setCachedStateField("profileIdleThresholds", clampedProfileIdleThresholds)
		}
	}

	// Helper function to handle threshold changes
	const handleThresholdChange = (value: number) => {
		if (selectedThresholdProfile === "default") {
			setCachedStateField("autoCondenseContextPercent", value)
			clampIdleToTrigger(value)
		} else {
			const newThresholds = {
				...profileThresholds,
				[selectedThresholdProfile]: value,
			}

			setCachedStateField("profileThresholds", newThresholds)

			const profileIdle = profileIdleThresholds[selectedThresholdProfile]
			if (profileIdle !== undefined && profileIdle !== -1 && profileIdle > value) {
				setCachedStateField("profileIdleThresholds", {
					...profileIdleThresholds,
					[selectedThresholdProfile]: value,
				})
			}
		}
	}

	// Effective main condense threshold for the profile currently selected in
	// the idle-threshold UI: the idle threshold value may never exceed it,
	// though the slider's max stays at 100%. Invalid profile overrides resolve
	// to the global threshold, matching the runtime fallback.
	const getMainThresholdForIdleProfile = () => {
		if (selectedIdleProfile === "default") {
			return autoCondenseContextPercent
		}
		return resolveCondensePercent(autoCondenseContextPercent, profileThresholds[selectedIdleProfile])
	}

	// Helper function to get the current idle threshold value based on selected profile.
	// The displayed value is capped at the profile's effective main threshold to match
	// the runtime behavior (Task.ts resolves idlePercent = Math.min(idlePercentSetting,
	// mainPercent)); the inherited setting itself is left unchanged. Invalid profile
	// overrides display the global idle threshold they fall back to at runtime.
	const getCurrentIdleThresholdValue = () => {
		if (selectedIdleProfile === "default") {
			return Math.min(idleCondenseContextPercent, getMainThresholdForIdleProfile())
		}
		return Math.min(
			resolveCondensePercent(idleCondenseContextPercent, profileIdleThresholds[selectedIdleProfile]),
			getMainThresholdForIdleProfile(),
		)
	}

	// Helper function to handle idle threshold changes (value clamped to the main threshold)
	const handleIdleThresholdChange = (value: number) => {
		const clamped = Math.min(value, getMainThresholdForIdleProfile())
		if (selectedIdleProfile === "default") {
			setCachedStateField("idleCondenseContextPercent", clamped)
		} else {
			setCachedStateField("profileIdleThresholds", {
				...profileIdleThresholds,
				[selectedIdleProfile]: clamped,
			})
		}
	}

	// Helper function to get the current idle time value based on selected profile.
	// Mirrors resolveIdleCondenseTimeInSeconds in Task.ts: only -1/undefined inherit
	// and values >= 0 override; anything else falls back to the global value.
	const getCurrentIdleTimeValue = () => {
		if (selectedIdleProfile === "default") {
			return idleCondenseTimeInSeconds
		}
		const profileSeconds = profileIdleCondenseTimes[selectedIdleProfile]
		if (profileSeconds === undefined || profileSeconds === -1) {
			return idleCondenseTimeInSeconds
		}
		if (profileSeconds >= 0) {
			return profileSeconds
		}
		return idleCondenseTimeInSeconds
	}

	// Helper function to handle idle time changes
	const handleIdleTimeChange = (value: number) => {
		const clamped = Math.max(0, Math.round(value || 0))
		if (selectedIdleProfile === "default") {
			setCachedStateField("idleCondenseTimeInSeconds", clamped)
		} else {
			setCachedStateField("profileIdleCondenseTimes", {
				...profileIdleCondenseTimes,
				[selectedIdleProfile]: clamped,
			})
		}
	}

	// Reset the selected profile's idle overrides back to inheriting the global values.
	const handleIdleProfileUseGlobal = () => {
		if (selectedIdleProfile === "default") {
			return
		}
		setCachedStateField("profileIdleThresholds", { ...profileIdleThresholds, [selectedIdleProfile]: -1 })
		setCachedStateField("profileIdleCondenseTimes", { ...profileIdleCondenseTimes, [selectedIdleProfile]: -1 })
	}

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader description={t("settings:contextManagement.description")}>
				{t("settings:sections.contextManagement")}
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="context-open-tabs"
					section="contextManagement"
					label={t("settings:contextManagement.openTabs.label")}>
					<span className="block font-medium mb-1">{t("settings:contextManagement.openTabs.label")}</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={500}
							step={1}
							value={[maxOpenTabsContext ?? 20]}
							onValueChange={([value]) => setCachedStateField("maxOpenTabsContext", value)}
							data-testid="open-tabs-limit-slider"
						/>
						<span className="w-10">{maxOpenTabsContext ?? 20}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.openTabs.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-workspace-files"
					section="contextManagement"
					label={t("settings:contextManagement.workspaceFiles.label")}>
					<span className="block font-medium mb-1">
						{t("settings:contextManagement.workspaceFiles.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={500}
							step={1}
							value={[maxWorkspaceFiles ?? 200]}
							onValueChange={([value]) => setCachedStateField("maxWorkspaceFiles", value)}
							data-testid="workspace-files-limit-slider"
						/>
						<span className="w-10">{maxWorkspaceFiles ?? 200}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.workspaceFiles.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-git-status-files"
					section="contextManagement"
					label={t("settings:contextManagement.maxGitStatusFiles.label")}>
					<span className="block font-medium mb-1">
						{t("settings:contextManagement.maxGitStatusFiles.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={50}
							step={1}
							value={[maxGitStatusFiles ?? 0]}
							onValueChange={([value]) => setCachedStateField("maxGitStatusFiles", value)}
							data-testid="max-git-status-files-slider"
						/>
						<span className="w-10">{maxGitStatusFiles ?? 0}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.maxGitStatusFiles.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-show-rooignored-files"
					section="contextManagement"
					label={t("settings:contextManagement.rooignore.label")}>
					<VSCodeCheckbox
						checked={showRooIgnoredFiles}
						onChange={(e: any) => setCachedStateField("showRooIgnoredFiles", e.target.checked)}
						data-testid="show-rooignored-files-checkbox">
						<label className="block font-medium mb-1">
							{t("settings:contextManagement.rooignore.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.rooignore.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-enable-subfolder-rules"
					section="contextManagement"
					label={t("settings:contextManagement.enableSubfolderRules.label")}>
					<VSCodeCheckbox
						checked={enableSubfolderRules}
						onChange={(e: any) => setCachedStateField("enableSubfolderRules", e.target.checked)}
						data-testid="enable-subfolder-rules-checkbox">
						<label className="block font-medium mb-1">
							{t("settings:contextManagement.enableSubfolderRules.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.enableSubfolderRules.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-image-file-size"
					section="contextManagement"
					label={t("settings:contextManagement.maxImageFileSize.label")}>
					<div className="flex flex-col gap-2">
						<span className="font-medium">{t("settings:contextManagement.maxImageFileSize.label")}</span>
						<div className="flex items-center gap-4">
							<Input
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxImageFileSize ?? 5}
								min={1}
								max={100}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 100) {
										setCachedStateField("maxImageFileSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-image-file-size-input"
							/>
							<span>{t("settings:contextManagement.maxImageFileSize.mb")}</span>
						</div>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-2">
						{t("settings:contextManagement.maxImageFileSize.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-total-image-size"
					section="contextManagement"
					label={t("settings:contextManagement.maxTotalImageSize.label")}>
					<div className="flex flex-col gap-2">
						<span className="font-medium">{t("settings:contextManagement.maxTotalImageSize.label")}</span>
						<div className="flex items-center gap-4">
							<Input
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxTotalImageSize ?? 20}
								min={1}
								max={500}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 500) {
										setCachedStateField("maxTotalImageSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-total-image-size-input"
							/>
							<span>{t("settings:contextManagement.maxTotalImageSize.mb")}</span>
						</div>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-2">
						{t("settings:contextManagement.maxTotalImageSize.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-diagnostic-messages"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.includeMessages.label")}>
					<VSCodeCheckbox
						checked={includeDiagnosticMessages}
						onChange={(e: any) => setCachedStateField("includeDiagnosticMessages", e.target.checked)}
						data-testid="include-diagnostic-messages-checkbox">
						<label className="block font-medium mb-1">
							{t("settings:contextManagement.diagnostics.includeMessages.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.diagnostics.includeMessages.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-diagnostic-messages"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.maxMessages.label")}>
					<span className="block font-medium mb-1">
						{t("settings:contextManagement.diagnostics.maxMessages.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={1}
							max={100}
							step={1}
							value={[
								maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
									? 100
									: (maxDiagnosticMessages ?? 50),
							]}
							onValueChange={([value]) => {
								// When slider reaches 100, set to -1 (unlimited)
								setCachedStateField("maxDiagnosticMessages", value === 100 ? -1 : value)
							}}
							data-testid="max-diagnostic-messages-slider"
							aria-label={t("settings:contextManagement.diagnostics.maxMessages.label")}
							aria-valuemin={1}
							aria-valuemax={100}
							aria-valuenow={
								maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
									? 100
									: (maxDiagnosticMessages ?? 50)
							}
							aria-valuetext={
								(maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0) ||
								maxDiagnosticMessages === 100
									? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
									: `${maxDiagnosticMessages ?? 50} ${t("settings:contextManagement.diagnostics.maxMessages.label")}`
							}
						/>
						<span className="w-20 text-sm font-medium">
							{(maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0) ||
							maxDiagnosticMessages === 100
								? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
								: (maxDiagnosticMessages ?? 50)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCachedStateField("maxDiagnosticMessages", 50)}
							title={t("settings:contextManagement.diagnostics.maxMessages.resetTooltip")}
							className="p-1 h-6 w-6"
							disabled={maxDiagnosticMessages === 50}>
							<span className="codicon codicon-discard" />
						</Button>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.diagnostics.maxMessages.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-write-delay"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.delayAfterWrite.label")}>
					<span className="block font-medium mb-1">
						{t("settings:contextManagement.diagnostics.delayAfterWrite.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={5000}
							step={100}
							value={[writeDelayMs]}
							onValueChange={([value]) => setCachedStateField("writeDelayMs", value)}
							data-testid="write-delay-slider"
						/>
						<span className="w-20">{writeDelayMs}ms</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.diagnostics.delayAfterWrite.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-diff-fuzzy-threshold"
					section="contextManagement"
					label={t("settings:contextManagement.fileEdits.diffFuzzyThreshold.label")}>
					<span className="block font-medium mb-1">
						{t("settings:contextManagement.fileEdits.diffFuzzyThreshold.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0.5}
							max={1}
							step={0.01}
							value={[diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD]}
							onValueChange={([value]) => setCachedStateField("diffFuzzyThreshold", value)}
							data-testid="diff-fuzzy-threshold-slider"
						/>
						<span className="w-20">
							{((diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD) * 100).toFixed(0)}%
						</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.fileEdits.diffFuzzyThreshold.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-time"
					section="contextManagement"
					label={t("settings:contextManagement.includeCurrentTime.label")}>
					<VSCodeCheckbox
						checked={includeCurrentTime}
						onChange={(e: any) => setCachedStateField("includeCurrentTime", e.target.checked)}
						data-testid="include-current-time-checkbox">
						<label className="block font-medium mb-1">
							{t("settings:contextManagement.includeCurrentTime.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.includeCurrentTime.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-cost"
					section="contextManagement"
					label={t("settings:contextManagement.includeCurrentCost.label")}>
					<VSCodeCheckbox
						checked={includeCurrentCost}
						onChange={(e: any) => setCachedStateField("includeCurrentCost", e.target.checked)}
						data-testid="include-current-cost-checkbox">
						<label className="block font-medium mb-1">
							{t("settings:contextManagement.includeCurrentCost.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.includeCurrentCost.description")}
					</div>
				</SearchableSetting>
			</Section>
			<Section className="pt-2">
				{/* Context Condensing Prompt Editor */}
				<SearchableSetting
					settingId="context-condense-prompt"
					section="contextManagement"
					label={t("prompts:supportPrompts.types.CONDENSE.label")}>
					<div className="flex justify-between items-center mb-1">
						<label className="block font-medium">{t("prompts:supportPrompts.types.CONDENSE.label")}</label>
						<StandardTooltip content={t("prompts:supportPrompts.resetPrompt", { promptType: "CONDENSE" })}>
							<Button variant="ghost" size="icon" onClick={handleCondenseReset}>
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:supportPrompts.types.CONDENSE.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={getCondensePromptValue()}
						onInput={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateCondensePrompt(value)
						}}
						rows={6}
						className="w-full"
						data-testid="condense-prompt-textarea"
					/>
				</SearchableSetting>

				{/* Auto Condense Context */}
				<SearchableSetting
					settingId="context-auto-condense"
					section="contextManagement"
					label={t("settings:contextManagement.autoCondenseContext.name")}>
					<VSCodeCheckbox
						checked={autoCondenseContext}
						onChange={(e: any) => setCachedStateField("autoCondenseContext", e.target.checked)}
						data-testid="auto-condense-context-checkbox">
						<span className="font-medium">{t("settings:contextManagement.autoCondenseContext.name")}</span>
					</VSCodeCheckbox>
				</SearchableSetting>
				{autoCondenseContext && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<ListChevronsDownUp size={16} />
							<div>{t("settings:contextManagement.condensingThreshold.label")}</div>
						</div>
						<div>
							<Select
								value={selectedThresholdProfile || "default"}
								onValueChange={(value) => {
									setSelectedThresholdProfile(value)
								}}
								data-testid="threshold-profile-select">
								{/* At narrow editor widths the selected-profile text must wrap
									instead of one-line clamping, so it is never clipped. Radix
									drops SelectValue classNames, so the override has to target
									the clamping child rule from the trigger itself. */}
								<SelectTrigger className="w-full max-[380px]:h-auto max-[380px]:whitespace-normal max-[380px]:*:data-[slot=select-value]:line-clamp-none!">
									<SelectValue
										placeholder={
											t("settings:contextManagement.condensingThreshold.selectProfile") ||
											"Select profile for threshold"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">
										{t("settings:contextManagement.condensingThreshold.defaultProfile") ||
											"Default (applies to all unconfigured profiles)"}
									</SelectItem>
									{(listApiConfigMeta || []).map((config) => {
										const profileThreshold = profileThresholds[config.id]
										const thresholdDisplay =
											profileThreshold !== undefined
												? profileThreshold === -1
													? ` ${t(
															"settings:contextManagement.condensingThreshold.usesGlobal",
															{
																threshold: autoCondenseContextPercent,
															},
														)}`
													: ` (${profileThreshold}%)`
												: ""
										return (
											<SelectItem key={config.id} value={config.id}>
												{config.name}
												{thresholdDisplay}
											</SelectItem>
										)
									})}
								</SelectContent>
							</Select>
						</div>

						{/* Threshold Slider */}
						<div>
							<div className="flex items-center gap-2">
								<Slider
									min={10}
									max={100}
									step={1}
									value={[getCurrentThresholdValue()]}
									onValueChange={([value]) => handleThresholdChange(value)}
									data-testid="condense-threshold-slider"
								/>
								<span className="w-20">{getCurrentThresholdValue()}%</span>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{selectedThresholdProfile === "default"
									? t("settings:contextManagement.condensingThreshold.defaultDescription", {
											threshold: autoCondenseContextPercent,
										})
									: t("settings:contextManagement.condensingThreshold.profileDescription")}
							</div>
						</div>

						{/* Idle Condensing */}
						<SearchableSetting
							settingId="context-idle-condense"
							section="contextManagement"
							label={t("settings:contextManagement.idleCondensing.name")}>
							<VSCodeCheckbox
								checked={idleCondenseContext}
								onChange={(e: Event | FormEvent<HTMLElement>) => {
									if (!isCheckboxTarget(e.target)) {
										return
									}
									setCachedStateField("idleCondenseContext", e.target.checked)
								}}
								data-testid="idle-condense-context-checkbox">
								<span className="font-medium">
									{t("settings:contextManagement.idleCondensing.name")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:contextManagement.idleCondensing.description")}
							</div>
						</SearchableSetting>
						{idleCondenseContext && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
								<div>
									<Select
										value={selectedIdleProfile || "default"}
										onValueChange={(value) => {
											setSelectedIdleProfile(value)
										}}
										data-testid="idle-threshold-profile-select">
										{/* Same narrow-width wrap fix as the main threshold select. */}
										<SelectTrigger className="w-full max-[380px]:h-auto max-[380px]:whitespace-normal max-[380px]:*:data-[slot=select-value]:line-clamp-none!">
											<SelectValue
												placeholder={
													t("settings:contextManagement.condensingThreshold.selectProfile") ||
													"Select profile for threshold"
												}
											/>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="default">
												{t("settings:contextManagement.condensingThreshold.defaultProfile") ||
													"Default (applies to all unconfigured profiles)"}
											</SelectItem>
											{(listApiConfigMeta || []).map((config) => {
												const profileIdleThreshold = profileIdleThresholds[config.id]
												const idleDisplay =
													profileIdleThreshold !== undefined && profileIdleThreshold !== -1
														? ` (${profileIdleThreshold}%)`
														: ""
												return (
													<SelectItem key={config.id} value={config.id}>
														{config.name}
														{idleDisplay}
													</SelectItem>
												)
											})}
										</SelectContent>
									</Select>
								</div>

								{/* Idle Threshold Slider */}
								<div>
									<div className="flex items-center gap-2">
										<Slider
											min={5}
											max={100}
											step={1}
											value={[getCurrentIdleThresholdValue()]}
											onValueChange={([value]) => handleIdleThresholdChange(value)}
											data-testid="idle-condense-threshold-slider"
											aria-label={t("settings:contextManagement.idleCondensing.name")}
										/>
										<span className="w-20">{getCurrentIdleThresholdValue()}%</span>
									</div>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{selectedIdleProfile === "default"
											? t("settings:contextManagement.idleCondensing.thresholdDescription")
											: t(
													"settings:contextManagement.idleCondensing.thresholdProfileDescription",
												)}
									</div>
								</div>

								{/* Idle Time Input */}
								<SearchableSetting
									settingId="context-idle-time"
									section="contextManagement"
									label={idleTimeLabel}>
									<div className="flex items-center gap-2">
										<span className="font-medium">{idleTimeLabel}</span>
										<Input
											aria-label={idleTimeLabel}
											type="number"
											min={0}
											step={1}
											value={getCurrentIdleTimeValue()}
											onChange={(e) =>
												// Number (not parseInt) so a pasted value like "1e3"
												// is read as 1000 instead of stopping at "1".
												handleIdleTimeChange(Number((e.target as HTMLInputElement).value))
											}
											className="w-24"
											data-testid="idle-condense-time-input"
										/>
										<span>{t("settings:contextManagement.idleCondensing.idleTime.seconds")}</span>
									</div>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:contextManagement.idleCondensing.idleTime.description")}
									</div>
								</SearchableSetting>

								{selectedIdleProfile !== "default" && (
									<div>
										<Button
											onClick={handleIdleProfileUseGlobal}
											data-testid="idle-condense-use-global-button">
											{t("settings:contextManagement.idleCondensing.useGlobal")}
										</Button>
									</div>
								)}
							</div>
						)}
					</div>
				)}
			</Section>
		</div>
	)
}
