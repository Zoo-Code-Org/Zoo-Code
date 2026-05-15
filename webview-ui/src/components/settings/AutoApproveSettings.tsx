import { HTMLAttributes, useMemo, useState } from "react"
import { X } from "lucide-react"
import { Trans } from "react-i18next"
import { Package } from "@roo/package"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { vscode } from "@/utils/vscode"
import { Button, Input, Slider } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { AutoApproveToggle } from "./AutoApproveToggle"
import { MaxLimitInputs } from "./MaxLimitInputs"
import { useAutoApprovalState } from "@/hooks/useAutoApprovalState"

type AutoApproveSettingsProps = HTMLAttributes<HTMLDivElement> & {
	autoApprovalEnabled?: boolean
	yoloMode?: boolean
	alwaysAllowReadOnly?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowFollowupQuestions?: boolean
	followupAutoApproveTimeoutMs?: number
	allowedCommands?: string[]
	allowedMaxRequests?: number | undefined
	allowedMaxCost?: number | undefined
	deniedCommands?: string[]
	setCachedStateField: SetCachedStateField<
		| "autoApprovalEnabled"
		| "yoloMode"
		| "alwaysAllowReadOnly"
		| "alwaysAllowReadOnlyOutsideWorkspace"
		| "alwaysAllowWrite"
		| "alwaysAllowWriteOutsideWorkspace"
		| "alwaysAllowWriteProtected"
		| "alwaysAllowMcp"
		| "alwaysAllowModeSwitch"
		| "alwaysAllowSubtasks"
		| "alwaysAllowExecute"
		| "alwaysAllowFollowupQuestions"
		| "followupAutoApproveTimeoutMs"
		| "allowedCommands"
		| "allowedMaxRequests"
		| "allowedMaxCost"
		| "deniedCommands"
	>
}

export const AutoApproveSettings = ({
	autoApprovalEnabled,
	yoloMode,
	alwaysAllowReadOnly,
	alwaysAllowReadOnlyOutsideWorkspace,
	alwaysAllowWrite,
	alwaysAllowWriteOutsideWorkspace,
	alwaysAllowWriteProtected,
	alwaysAllowMcp,
	alwaysAllowModeSwitch,
	alwaysAllowSubtasks,
	alwaysAllowExecute,
	alwaysAllowFollowupQuestions,
	followupAutoApproveTimeoutMs = 60000,
	allowedCommands,
	allowedMaxRequests,
	allowedMaxCost,
	deniedCommands,
	setCachedStateField,
	...props
}: AutoApproveSettingsProps) => {
	const { t } = useAppTranslation()
	const [commandInput, setCommandInput] = useState("")
	const [deniedCommandInput, setDeniedCommandInput] = useState("")
	const toggles = useMemo(
		() => ({
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowFollowupQuestions,
		}),
		[
			alwaysAllowExecute,
			alwaysAllowFollowupQuestions,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowReadOnly,
			alwaysAllowSubtasks,
			alwaysAllowWrite,
		],
	)
	const { effectiveAutoApprovalEnabled } = useAutoApprovalState(toggles, autoApprovalEnabled, yoloMode)
	const autoApproveControlsDisabled = yoloMode === true

	const handleAddCommand = () => {
		if (autoApproveControlsDisabled) {
			return
		}

		const currentCommands = allowedCommands ?? []

		if (commandInput && !currentCommands.includes(commandInput)) {
			const newCommands = [...currentCommands, commandInput]
			setCachedStateField("allowedCommands", newCommands)
			setCommandInput("")
		}
	}

	const handleAddDeniedCommand = () => {
		if (autoApproveControlsDisabled) {
			return
		}

		const currentCommands = deniedCommands ?? []

		if (deniedCommandInput && !currentCommands.includes(deniedCommandInput)) {
			const newCommands = [...currentCommands, deniedCommandInput]
			setCachedStateField("deniedCommands", newCommands)
			setDeniedCommandInput("")
		}
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.autoApprove")}</SectionHeader>

			<Section>
				<div className="space-y-4">
					<SearchableSetting
						settingId="auto-approve-enabled"
						section="autoApprove"
						label={t("settings:autoApprove.enabled")}>
						<VSCodeCheckbox
							checked={effectiveAutoApprovalEnabled}
							disabled={autoApproveControlsDisabled}
							aria-label={t("settings:autoApprove.toggleAriaLabel")}
							onChange={() => {
								if (autoApproveControlsDisabled) {
									return
								}

								setCachedStateField("autoApprovalEnabled", !(autoApprovalEnabled ?? false))
							}}>
							<span className="font-medium">{t("settings:autoApprove.enabled")}</span>
						</VSCodeCheckbox>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							<p>{t("settings:autoApprove.description")}</p>
							<p>
								<Trans
									i18nKey="settings:autoApprove.toggleShortcut"
									components={{
										SettingsLink: (
											<a
												href="#"
												className="text-vscode-textLink-foreground hover:underline cursor-pointer"
												onClick={(e) => {
													e.preventDefault()
													// Send message to open keyboard shortcuts with search for toggle command
													vscode.postMessage({
														type: "openKeyboardShortcuts",
														text: `${Package.name}.toggleAutoApprove`,
													})
												}}
											/>
										),
									}}
								/>
							</p>
							{autoApproveControlsDisabled && <p>{t("settings:autoApprove.enabledOverriddenByYolo")}</p>}
						</div>
					</SearchableSetting>

					<SearchableSetting
						settingId="auto-approve-yolo-mode"
						section="autoApprove"
						label={t("settings:autoApprove.yolo.label")}>
						<VSCodeCheckbox
							checked={yoloMode}
							onChange={(e: any) => setCachedStateField("yoloMode", e.target.checked)}
							data-testid="yolo-mode-checkbox">
							<span className="font-medium">{t("settings:autoApprove.yolo.label")}</span>
						</VSCodeCheckbox>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							<p>{t("settings:autoApprove.yolo.description")}</p>
							<p>{t("settings:autoApprove.yolo.controlsDisabled")}</p>
						</div>
					</SearchableSetting>

					<div
						className={
							autoApproveControlsDisabled ? "space-y-4 pointer-events-none opacity-50" : "space-y-4"
						}>
						<AutoApproveToggle
							alwaysAllowReadOnly={alwaysAllowReadOnly}
							alwaysAllowWrite={alwaysAllowWrite}
							alwaysAllowMcp={alwaysAllowMcp}
							alwaysAllowModeSwitch={alwaysAllowModeSwitch}
							alwaysAllowSubtasks={alwaysAllowSubtasks}
							alwaysAllowExecute={alwaysAllowExecute}
							alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
							onToggle={(key, value) => setCachedStateField(key, value)}
							disabled={autoApproveControlsDisabled}
						/>

						<MaxLimitInputs
							allowedMaxRequests={allowedMaxRequests}
							allowedMaxCost={allowedMaxCost}
							onMaxRequestsChange={(value) => setCachedStateField("allowedMaxRequests", value)}
							onMaxCostChange={(value) => setCachedStateField("allowedMaxCost", value)}
						/>
					</div>
				</div>

				{/* ADDITIONAL SETTINGS */}

				{alwaysAllowReadOnly && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<span className="codicon codicon-eye" />
							<div>{t("settings:autoApprove.readOnly.label")}</div>
						</div>
						<SearchableSetting
							settingId="auto-approve-readonly-outside-workspace"
							section="autoApprove"
							label={t("settings:autoApprove.readOnly.outsideWorkspace.label")}>
							<VSCodeCheckbox
								checked={alwaysAllowReadOnlyOutsideWorkspace}
								disabled={autoApproveControlsDisabled}
								onChange={(e: any) =>
									setCachedStateField("alwaysAllowReadOnlyOutsideWorkspace", e.target.checked)
								}
								data-testid="always-allow-readonly-outside-workspace-checkbox">
								<span className="font-medium">
									{t("settings:autoApprove.readOnly.outsideWorkspace.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:autoApprove.readOnly.outsideWorkspace.description")}
							</div>
						</SearchableSetting>
					</div>
				)}

				{alwaysAllowWrite && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<span className="codicon codicon-edit" />
							<div>{t("settings:autoApprove.write.label")}</div>
						</div>
						<SearchableSetting
							settingId="auto-approve-write-outside-workspace"
							section="autoApprove"
							label={t("settings:autoApprove.write.outsideWorkspace.label")}>
							<VSCodeCheckbox
								checked={alwaysAllowWriteOutsideWorkspace}
								disabled={autoApproveControlsDisabled}
								onChange={(e: any) =>
									setCachedStateField("alwaysAllowWriteOutsideWorkspace", e.target.checked)
								}
								data-testid="always-allow-write-outside-workspace-checkbox">
								<span className="font-medium">
									{t("settings:autoApprove.write.outsideWorkspace.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:autoApprove.write.outsideWorkspace.description")}
							</div>
						</SearchableSetting>
						<SearchableSetting
							settingId="auto-approve-write-protected"
							section="autoApprove"
							label={t("settings:autoApprove.write.protected.label")}>
							<VSCodeCheckbox
								checked={alwaysAllowWriteProtected}
								disabled={autoApproveControlsDisabled}
								onChange={(e: any) =>
									setCachedStateField("alwaysAllowWriteProtected", e.target.checked)
								}
								data-testid="always-allow-write-protected-checkbox">
								<span className="font-medium">{t("settings:autoApprove.write.protected.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
								{t("settings:autoApprove.write.protected.description")}
							</div>
						</SearchableSetting>
					</div>
				)}

				{alwaysAllowFollowupQuestions && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<span className="codicon codicon-question" />
							<div>{t("settings:autoApprove.followupQuestions.label")}</div>
						</div>
						<SearchableSetting
							settingId="auto-approve-followup-timeout"
							section="autoApprove"
							label={t("settings:autoApprove.followupQuestions.timeoutLabel")}>
							<div className="flex items-center gap-2">
								<Slider
									min={1000}
									max={300000}
									step={1000}
									value={[followupAutoApproveTimeoutMs]}
									disabled={autoApproveControlsDisabled}
									onValueChange={([value]) =>
										setCachedStateField("followupAutoApproveTimeoutMs", value)
									}
									data-testid="followup-timeout-slider"
								/>
								<span className="w-20">{followupAutoApproveTimeoutMs / 1000}s</span>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:autoApprove.followupQuestions.timeoutLabel")}
							</div>
						</SearchableSetting>
					</div>
				)}

				{alwaysAllowExecute && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<span className="codicon codicon-terminal" />
							<div>{t("settings:autoApprove.execute.label")}</div>
						</div>

						<SearchableSetting
							settingId="auto-approve-allowed-commands"
							section="autoApprove"
							label={t("settings:autoApprove.execute.allowedCommands")}>
							<label className="block font-medium mb-1" data-testid="allowed-commands-heading">
								{t("settings:autoApprove.execute.allowedCommands")}
							</label>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:autoApprove.execute.allowedCommandsDescription")}
							</div>
						</SearchableSetting>

						<div className="flex gap-2">
							<Input
								value={commandInput}
								onChange={(e: any) => setCommandInput(e.target.value)}
								onKeyDown={(e: any) => {
									if (e.key === "Enter") {
										e.preventDefault()
										handleAddCommand()
									}
								}}
								placeholder={t("settings:autoApprove.execute.commandPlaceholder")}
								className="grow"
								disabled={autoApproveControlsDisabled}
								data-testid="command-input"
							/>
							<Button
								className="h-8"
								onClick={handleAddCommand}
								disabled={autoApproveControlsDisabled}
								data-testid="add-command-button">
								{t("settings:autoApprove.execute.addButton")}
							</Button>
						</div>

						<div className="flex flex-wrap gap-2">
							{(allowedCommands ?? []).map((cmd, index) => (
								<Button
									key={index}
									variant="secondary"
									data-testid={`remove-command-${index}`}
									disabled={autoApproveControlsDisabled}
									onClick={() => {
										const newCommands = (allowedCommands ?? []).filter((_, i) => i !== index)
										setCachedStateField("allowedCommands", newCommands)
									}}>
									<div className="flex flex-row items-center gap-1">
										<div>{cmd}</div>
										<X className="text-foreground scale-75" />
									</div>
								</Button>
							))}
						</div>

						{/* Denied Commands Section */}
						<SearchableSetting
							settingId="auto-approve-denied-commands"
							section="autoApprove"
							label={t("settings:autoApprove.execute.deniedCommands")}
							className="mt-6">
							<label className="block font-medium mb-1" data-testid="denied-commands-heading">
								{t("settings:autoApprove.execute.deniedCommands")}
							</label>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:autoApprove.execute.deniedCommandsDescription")}
							</div>
						</SearchableSetting>

						<div className="flex gap-2">
							<Input
								value={deniedCommandInput}
								onChange={(e: any) => setDeniedCommandInput(e.target.value)}
								onKeyDown={(e: any) => {
									if (e.key === "Enter") {
										e.preventDefault()
										handleAddDeniedCommand()
									}
								}}
								placeholder={t("settings:autoApprove.execute.deniedCommandPlaceholder")}
								className="grow"
								disabled={autoApproveControlsDisabled}
								data-testid="denied-command-input"
							/>
							<Button
								className="h-8"
								onClick={handleAddDeniedCommand}
								disabled={autoApproveControlsDisabled}
								data-testid="add-denied-command-button">
								{t("settings:autoApprove.execute.addButton")}
							</Button>
						</div>

						<div className="flex flex-wrap gap-2">
							{(deniedCommands ?? []).map((cmd, index) => (
								<Button
									key={index}
									variant="secondary"
									data-testid={`remove-denied-command-${index}`}
									disabled={autoApproveControlsDisabled}
									onClick={() => {
										const newCommands = (deniedCommands ?? []).filter((_, i) => i !== index)
										setCachedStateField("deniedCommands", newCommands)
									}}>
									<div className="flex flex-row items-center gap-1">
										<div>{cmd}</div>
										<X className="text-foreground scale-75" />
									</div>
								</Button>
							))}
						</div>
					</div>
				)}
			</Section>
		</div>
	)
}
