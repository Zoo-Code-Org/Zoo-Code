import { HTMLAttributes, useMemo } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { telemetryClient } from "@/utils/TelemetryClient"
import {
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES,
} from "@roo-code/types"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { Slider, Button } from "../ui"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"

export const CHAT_FONT_SIZE_MIN = 8
export const CHAT_FONT_SIZE_MAX = 32
export const CHAT_FONT_SIZE_DEFAULT = 13

interface UISettingsProps extends HTMLAttributes<HTMLDivElement> {
	reasoningBlockCollapsed: boolean
	enterBehavior: "send" | "newline"
	chatInputEffect: "marquee" | "breathing"
	chatFontSize?: number
	tableStriped?: boolean
	autoCloseZooOpenedFiles?: boolean
	autoCloseZooOpenedFilesAfterUserEdited?: boolean
	autoCloseZooOpenedNewFiles?: boolean
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const UISettings = ({
	reasoningBlockCollapsed,
	enterBehavior,
	chatInputEffect,
	chatFontSize,
	tableStriped,
	autoCloseZooOpenedFiles,
	autoCloseZooOpenedFilesAfterUserEdited,
	autoCloseZooOpenedNewFiles,
	setCachedStateField,
	...props
}: UISettingsProps) => {
	const { t } = useAppTranslation()

	// Detect platform for dynamic modifier key display
	const primaryMod = useMemo(() => {
		const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
		return isMac ? "⌘" : "Ctrl"
	}, [])

	const handleReasoningBlockCollapsedChange = (value: boolean) => {
		setCachedStateField("reasoningBlockCollapsed", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_collapse_thinking_changed", {
			enabled: value,
		})
	}

	const handleEnterBehaviorChange = (requireCtrlEnter: boolean) => {
		const newBehavior = requireCtrlEnter ? "newline" : "send"
		setCachedStateField("enterBehavior", newBehavior)

		// Track telemetry event
		telemetryClient.capture("ui_settings_enter_behavior_changed", {
			behavior: newBehavior,
		})
	}

	const handleChatFontSizeChange = (value: number) => {
		setCachedStateField("chatFontSize", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_chat_font_size_changed", {
			value,
		})
	}

	const handleChatFontSizeReset = () => {
		setCachedStateField("chatFontSize", undefined)

		// Track telemetry event
		telemetryClient.capture("ui_settings_chat_font_size_reset")
	}

	// VSCodeDropdown's onChange is typed as an intersection of a native Event
	// handler and a FormEventHandler, so we accept `unknown` (assignable to both)
	// and narrow to the actual <select> element.
	const handleChatInputEffectChange = (e: unknown) => {
		const value = (e as { target: HTMLSelectElement }).target.value as "marquee" | "breathing"
		if (value) {
			setCachedStateField("chatInputEffect", value)
		}
	}

	const handleTableStripedChange = (value: boolean) => {
		setCachedStateField("tableStriped", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_table_striped_changed", {
			enabled: value,
		})
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.ui")}</SectionHeader>

			<Section>
				<div className="space-y-6">
					{/* Collapse Thinking Messages Setting */}
					<SearchableSetting
						settingId="ui-collapse-thinking"
						section="ui"
						label={t("settings:ui.collapseThinking.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={reasoningBlockCollapsed}
								onChange={(e: any) => handleReasoningBlockCollapsedChange(e.target.checked)}
								data-testid="collapse-thinking-checkbox">
								<span className="font-medium">{t("settings:ui.collapseThinking.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.collapseThinking.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Enter Key Behavior Setting */}
					<SearchableSetting
						settingId="ui-enter-behavior"
						section="ui"
						label={t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={enterBehavior === "newline"}
								onChange={(e: any) => handleEnterBehaviorChange(e.target.checked)}
								data-testid="enter-behavior-checkbox">
								<span className="font-medium">
									{t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.requireCtrlEnterToSend.description", { primaryMod })}
							</div>
						</div>
					</SearchableSetting>

					{/* AI Working Input Box Effect Setting */}
					<SearchableSetting
						settingId="ui-chat-input-effect"
						section="ui"
						label={t("settings:ui.chatInputEffect.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeDropdown
								value={chatInputEffect}
								onChange={handleChatInputEffectChange}
								data-testid="chat-input-effect-dropdown">
								<VSCodeOption value="marquee">{t("settings:ui.chatInputEffect.marquee")}</VSCodeOption>
								<VSCodeOption value="breathing">
									{t("settings:ui.chatInputEffect.breathing")}
								</VSCodeOption>
							</VSCodeDropdown>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.chatInputEffect.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Chat Font Size Setting */}
					<SearchableSetting
						settingId="ui-chat-font-size"
						section="ui"
						label={t("settings:ui.chatFontSize.label")}>
						<div className="flex flex-col gap-1">
							<label className="block font-medium mb-1">{t("settings:ui.chatFontSize.label")}</label>
							<div className="flex flex-wrap items-center gap-2">
								<Slider
									className="min-w-0 flex-1"
									min={CHAT_FONT_SIZE_MIN}
									max={CHAT_FONT_SIZE_MAX}
									step={1}
									value={[chatFontSize ?? CHAT_FONT_SIZE_DEFAULT]}
									onValueChange={([value]) => handleChatFontSizeChange(value)}
									data-testid="chat-font-size-slider"
								/>
								<span className="w-12 text-right">{chatFontSize ?? CHAT_FONT_SIZE_DEFAULT}px</span>
								<Button
									className="h-auto max-w-full whitespace-normal text-center"
									variant="secondary"
									size="sm"
									disabled={chatFontSize === undefined}
									onClick={handleChatFontSizeReset}
									data-testid="chat-font-size-reset">
									{t("settings:ui.chatFontSize.reset")}
								</Button>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:ui.chatFontSize.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close Zoo opened files */}
					<SearchableSetting
						settingId="ui-auto-close-zoo-opened-files"
						section="ui"
						label={t("settings:ui.autoCloseZooOpenedFiles.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={autoCloseZooOpenedFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES}
								onChange={(e: any) => setCachedStateField("autoCloseZooOpenedFiles", e.target.checked)}
								data-testid="auto-close-zoo-opened-files-checkbox">
								<span className="font-medium">{t("settings:ui.autoCloseZooOpenedFiles.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseZooOpenedFiles.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close Zoo opened files after user interaction */}
					<SearchableSetting
						settingId="ui-auto-close-zoo-opened-files-after-user-edited"
						section="ui"
						label={t("settings:ui.autoCloseZooOpenedFilesAfterUserEdited.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={
									autoCloseZooOpenedFilesAfterUserEdited ??
									DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED
								}
								onChange={(e: any) =>
									setCachedStateField("autoCloseZooOpenedFilesAfterUserEdited", e.target.checked)
								}
								data-testid="auto-close-zoo-opened-files-after-user-edited-checkbox">
								<span className="font-medium">
									{t("settings:ui.autoCloseZooOpenedFilesAfterUserEdited.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseZooOpenedFilesAfterUserEdited.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close Zoo opened new files */}
					<SearchableSetting
						settingId="ui-auto-close-zoo-opened-new-files"
						section="ui"
						label={t("settings:ui.autoCloseZooOpenedNewFiles.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={autoCloseZooOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES}
								onChange={(e: any) =>
									setCachedStateField("autoCloseZooOpenedNewFiles", e.target.checked)
								}
								data-testid="auto-close-zoo-opened-new-files-checkbox">
								<span className="font-medium">{t("settings:ui.autoCloseZooOpenedNewFiles.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseZooOpenedNewFiles.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Markdown Table Striping Setting */}
					<SearchableSetting
						settingId="ui-table-striped"
						section="ui"
						label={t("settings:ui.tableStriped.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={tableStriped ?? false}
								onChange={(e: any) => handleTableStripedChange(e.target.checked)}
								data-testid="table-striped-checkbox">
								<span className="font-medium">{t("settings:ui.tableStriped.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.tableStriped.description")}
							</div>
						</div>
					</SearchableSetting>
				</div>
			</Section>
		</div>
	)
}
