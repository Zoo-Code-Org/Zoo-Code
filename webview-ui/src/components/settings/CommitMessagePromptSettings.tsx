import React from "react"
import { VSCodeCheckbox, VSCodeTextArea, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import {
	MAX_COMMIT_MESSAGE_PROFILES,
	createCommitMessageProfileId,
	createCommitMessageProfileName,
	defaultCommitMessageAttributionSettings,
	defaultCommitMessageGitContextSettings,
	normalizeCommitMessageProfiles,
	type CommitMessageAttributionSettings,
	type CommitMessageGitContextSettings,
	type CommitMessageProfileSettings,
	type CommitMessageProfilesSettings,
} from "@roo-code/types"
import { supportPrompt } from "@roo/support-prompt"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StandardTooltip,
} from "@src/components/ui"

interface CommitMessagePromptSettingsProps {
	listApiConfigMeta: Array<{ id: string; name: string }>
	customSupportPrompts: Record<string, string | undefined>
	setCustomSupportPrompts: (prompts: Record<string, string | undefined>) => void
	commitMessageApiConfigId?: string
	setCommitMessageApiConfigId: (value: string) => void
	commitMessageGitContext?: CommitMessageGitContextSettings
	setCommitMessageGitContext: (value: CommitMessageGitContextSettings) => void
	commitMessageAttribution?: CommitMessageAttributionSettings
	setCommitMessageAttribution: (value: CommitMessageAttributionSettings) => void
	commitMessageProfiles?: CommitMessageProfilesSettings
	setCommitMessageProfiles: (value: CommitMessageProfilesSettings) => void
}

const CommitMessagePromptSettings = ({
	listApiConfigMeta,
	customSupportPrompts,
	setCustomSupportPrompts,
	commitMessageApiConfigId,
	setCommitMessageApiConfigId,
	commitMessageGitContext,
	setCommitMessageGitContext,
	commitMessageAttribution,
	setCommitMessageAttribution,
	commitMessageProfiles,
	setCommitMessageProfiles,
}: CommitMessagePromptSettingsProps) => {
	const { t } = useAppTranslation()
	const hasStoredProfiles = Boolean(commitMessageProfiles?.profiles?.length)
	const normalizedProfiles = normalizeCommitMessageProfiles(commitMessageProfiles, {
		prompt: customSupportPrompts.COMMIT_MESSAGE,
		apiConfigId: commitMessageApiConfigId,
		gitContext: commitMessageGitContext,
		attribution: commitMessageAttribution,
	})
	const activeProfile =
		normalizedProfiles.profiles.find((profile) => profile.id === normalizedProfiles.activeProfileId) ??
		normalizedProfiles.profiles[0]
	const profilePrompt = activeProfile.prompt ?? supportPrompt.get({}, "COMMIT_MESSAGE")
	const canAddProfile = normalizedProfiles.profiles.length < MAX_COMMIT_MESSAGE_PROFILES
	const canDeleteProfile = normalizedProfiles.profiles.length > 1
	const attributionSettings = activeProfile.attribution
	const suppressCheckboxChangesRef = React.useRef(false)

	const getRawProfiles = (): CommitMessageProfileSettings[] => {
		if (hasStoredProfiles) {
			return (commitMessageProfiles?.profiles ?? []).slice(0, MAX_COMMIT_MESSAGE_PROFILES)
		}

		return [
			{
				id: activeProfile.id,
				name: activeProfile.name,
				prompt: activeProfile.prompt,
				apiConfigId: activeProfile.apiConfigId,
				gitContext: commitMessageGitContext,
				attribution: commitMessageAttribution,
			},
		]
	}

	const isActiveRawProfile = (_profile: CommitMessageProfileSettings, index: number) =>
		normalizedProfiles.profiles[index]?.id === activeProfile.id
	const getActiveRawProfile = () => getRawProfiles().find(isActiveRawProfile)

	const suppressProfileTransitionCheckboxChanges = () => {
		suppressCheckboxChangesRef.current = true
		window.setTimeout(() => {
			suppressCheckboxChangesRef.current = false
		}, 0)
	}

	const persistProfiles = (
		profiles: CommitMessageProfileSettings[],
		activeProfileId: string,
		suppressCheckboxChanges = false,
	) => {
		if (suppressCheckboxChanges) {
			suppressProfileTransitionCheckboxChanges()
		}

		setCommitMessageProfiles({
			activeProfileId,
			profiles: profiles.slice(0, MAX_COMMIT_MESSAGE_PROFILES),
		})
	}

	const updateActiveProfile = (updates: Partial<CommitMessageProfileSettings>) => {
		if (!hasStoredProfiles) {
			if ("prompt" in updates) {
				const nextPrompts = { ...customSupportPrompts }
				if (updates.prompt === undefined) {
					delete nextPrompts.COMMIT_MESSAGE
				} else {
					nextPrompts.COMMIT_MESSAGE = updates.prompt
				}
				setCustomSupportPrompts(nextPrompts)
			}

			if ("apiConfigId" in updates) {
				setCommitMessageApiConfigId(updates.apiConfigId ?? "")
			}

			if (updates.gitContext) {
				setCommitMessageGitContext(updates.gitContext)
			}

			if ("name" in updates) {
				persistProfiles([{ ...getRawProfiles()[0], ...updates }], activeProfile.id, true)
			}

			return
		}

		const profiles = getRawProfiles().map((profile, index) =>
			isActiveRawProfile(profile, index) ? { ...profile, ...updates } : profile,
		)

		persistProfiles(profiles, activeProfile.id)
	}

	const updateAttributionSetting = (updates: Partial<CommitMessageAttributionSettings>) => {
		const currentAttribution = hasStoredProfiles
			? (getActiveRawProfile()?.attribution ?? {})
			: (commitMessageAttribution ?? {})
		const nextAttribution = { ...currentAttribution, ...updates }

		if (!hasStoredProfiles) {
			setCommitMessageAttribution(nextAttribution)
			return
		}

		const profiles = getRawProfiles().map((profile, index) =>
			isActiveRawProfile(profile, index) ? { ...profile, attribution: nextAttribution } : profile,
		)

		persistProfiles(profiles, activeProfile.id)
	}

	const updateGitContextSetting = <K extends keyof CommitMessageGitContextSettings>(
		key: K,
		value: CommitMessageGitContextSettings[K],
	) => {
		const currentGitContext = hasStoredProfiles
			? (getActiveRawProfile()?.gitContext ?? {})
			: (commitMessageGitContext ?? {})
		updateActiveProfile({ gitContext: { ...currentGitContext, [key]: value } })
	}

	const updateNumberSetting = (
		key: keyof CommitMessageGitContextSettings,
		value: string,
		min: number,
		max: number,
	) => {
		const parsed = Number(value)
		if (!Number.isFinite(parsed)) {
			return
		}

		updateGitContextSetting(key, Math.min(Math.max(Math.trunc(parsed), min), max) as never)
	}

	const handleActiveProfileChange = (profileId: string) => {
		const nextActiveProfile = normalizedProfiles.profiles.find((profile) => profile.id === profileId)
		if (!nextActiveProfile) {
			return
		}

		persistProfiles(getRawProfiles(), nextActiveProfile.id, true)
	}

	const handleAddProfile = () => {
		if (!canAddProfile) {
			return
		}

		const newProfile: CommitMessageProfileSettings = {
			id: createCommitMessageProfileId(),
			name: createCommitMessageProfileName(normalizedProfiles.profiles),
			gitContext: defaultCommitMessageGitContextSettings,
		}
		persistProfiles([...getRawProfiles(), newProfile], newProfile.id!, true)
	}

	const handleDeleteProfile = () => {
		if (!canDeleteProfile) {
			return
		}

		const profiles = getRawProfiles().filter((profile, index) => !isActiveRawProfile(profile, index))
		const nextActiveProfile = normalizeCommitMessageProfiles({ profiles }).profiles[0]
		persistProfiles(profiles, nextActiveProfile.id, true)
	}

	const getTextAreaValue = (event: Event | React.FormEvent<HTMLElement>) => {
		return (
			(event as unknown as CustomEvent)?.detail?.target?.value ??
			((event as any).target as HTMLTextAreaElement).value
		)
	}

	return (
		<div className="mt-4 flex flex-col gap-4 pl-3 border-l-2 border-vscode-button-background">
			{/* Profile selection controls. Keep this first so users understand which profile they are editing. */}
			<div className="flex flex-col gap-3">
				<div>
					<label className="block font-medium mb-1">
						{t("prompts:supportPrompts.commitMessage.profiles.title")}
					</label>
					<Select value={activeProfile.id} onValueChange={handleActiveProfileChange}>
						<SelectTrigger data-testid="commit-message-profile-select" className="w-full">
							<SelectValue placeholder={t("prompts:supportPrompts.commitMessage.profiles.select")} />
						</SelectTrigger>
						<SelectContent>
							{normalizedProfiles.profiles.map((profile) => (
								<SelectItem
									key={profile.id}
									value={profile.id}
									data-testid={`commit-message-${profile.id}-profile`}>
									{profile.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t("prompts:supportPrompts.commitMessage.profiles.description")}
					</div>
				</div>

				<div>
					<VSCodeTextField
						type="text"
						value={activeProfile.name}
						data-testid="commit-message-profile-name"
						onInput={(event) =>
							updateActiveProfile({ name: ((event as any).target as HTMLInputElement).value })
						}>
						<span className="font-medium">{t("prompts:supportPrompts.commitMessage.profiles.name")}</span>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t("prompts:supportPrompts.commitMessage.profiles.nameDescription")}
					</div>
				</div>

				<div className="flex flex-wrap gap-2 items-center">
					<Button variant="secondary" onClick={handleAddProfile} disabled={!canAddProfile}>
						{t("prompts:supportPrompts.commitMessage.profiles.add")}
					</Button>
					<Button variant="ghost" onClick={handleDeleteProfile} disabled={!canDeleteProfile}>
						{t("prompts:supportPrompts.commitMessage.profiles.delete")}
					</Button>
					<span className="text-sm text-vscode-descriptionForeground">
						{t("prompts:supportPrompts.commitMessage.profiles.limit", {
							count: MAX_COMMIT_MESSAGE_PROFILES,
						})}
					</span>
				</div>
			</div>

			{/* Prompt editor for the selected commit-message profile. */}
			<div>
				<div className="flex justify-between items-center mb-1">
					<div>
						<label className="block font-medium">{t("prompts:supportPrompts.prompt")}</label>
						<div className="text-sm text-vscode-descriptionForeground mt-1">
							{t("prompts:supportPrompts.commitMessage.promptDescription")}
						</div>
					</div>
					<StandardTooltip
						content={t("prompts:supportPrompts.resetPrompt", { promptType: "COMMIT_MESSAGE" })}>
						<Button variant="ghost" size="icon" onClick={() => updateActiveProfile({ prompt: undefined })}>
							<span className="codicon codicon-discard"></span>
						</Button>
					</StandardTooltip>
				</div>
				<VSCodeTextArea
					resize="vertical"
					value={profilePrompt}
					onInput={(event) => updateActiveProfile({ prompt: getTextAreaValue(event) })}
					rows={6}
					className="w-full"
					data-testid="commit-message-prompt-textarea"
				/>
			</div>

			{/* API configuration for the selected commit-message profile. */}
			<div>
				<label className="block font-medium mb-1">
					{t("prompts:supportPrompts.commitMessage.apiConfiguration")}
				</label>
				<Select
					value={activeProfile.apiConfigId || "-"}
					onValueChange={(value) => updateActiveProfile({ apiConfigId: value === "-" ? undefined : value })}>
					<SelectTrigger data-testid="commit-message-api-config-select" className="w-full">
						<SelectValue placeholder={t("prompts:supportPrompts.commitMessage.useCurrentConfig")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="-">{t("prompts:supportPrompts.commitMessage.useCurrentConfig")}</SelectItem>
						{(listApiConfigMeta || []).map((config) => (
							<SelectItem
								key={config.id}
								value={config.id}
								data-testid={`commit-message-${config.id}-option`}>
								{config.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="text-sm text-vscode-descriptionForeground mt-1">
					{t("prompts:supportPrompts.commitMessage.apiConfigDescription")}
				</div>
			</div>

			{/* Optional Git context controls. Required diff/change summary behavior is not user-toggleable. */}
			<div className="mt-2 flex flex-col gap-3">
				<div>
					<div className="font-medium mb-1">{t("prompts:supportPrompts.commitMessage.gitContext.title")}</div>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("prompts:supportPrompts.commitMessage.gitContext.description")}
					</div>
				</div>

				<div>
					<VSCodeTextField
						type="text"
						value={String(activeProfile.gitContext.diffContextLines)}
						onInput={(event) =>
							updateNumberSetting(
								"diffContextLines",
								((event as any).target as HTMLInputElement).value,
								0,
								20,
							)
						}>
						<span className="font-medium">
							{t("prompts:supportPrompts.commitMessage.gitContext.contextLines")}
						</span>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t("prompts:supportPrompts.commitMessage.gitContext.contextLinesDescription")}
					</div>
				</div>

				<CheckboxSetting
					checked={activeProfile.gitContext.includeDiffStats}
					label={t("prompts:supportPrompts.commitMessage.gitContext.includeDiffStats")}
					description={t("prompts:supportPrompts.commitMessage.gitContext.includeDiffStatsDescription")}
					onChange={(checked) => updateGitContextSetting("includeDiffStats", checked)}
					shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
				/>

				<CheckboxSetting
					checked={activeProfile.gitContext.includeCurrentBranch}
					label={t("prompts:supportPrompts.commitMessage.gitContext.includeBranch")}
					description={t("prompts:supportPrompts.commitMessage.gitContext.includeBranchDescription")}
					onChange={(checked) => updateGitContextSetting("includeCurrentBranch", checked)}
					shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
				/>

				<div className="pt-2 border-t border-vscode-panel-border">
					<CheckboxSetting
						checked={activeProfile.gitContext.includeRecentCommits}
						label={t("prompts:supportPrompts.commitMessage.gitContext.includeRecentCommits")}
						description={t("prompts:supportPrompts.commitMessage.gitContext.recentCommitsDescription")}
						onChange={(checked) => updateGitContextSetting("includeRecentCommits", checked)}
						shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
					/>

					{activeProfile.gitContext.includeRecentCommits && (
						<div className="flex flex-col gap-3 pl-4 mt-3">
							<div>
								<VSCodeTextField
									type="text"
									value={String(activeProfile.gitContext.recentCommitCount)}
									onInput={(event) =>
										updateNumberSetting(
											"recentCommitCount",
											((event as any).target as HTMLInputElement).value,
											1,
											20,
										)
									}>
									<span className="font-medium">
										{t("prompts:supportPrompts.commitMessage.gitContext.recentCommitCount")}
									</span>
								</VSCodeTextField>
								<div className="text-sm text-vscode-descriptionForeground mt-1">
									{t("prompts:supportPrompts.commitMessage.gitContext.recentCommitCountDescription")}
								</div>
							</div>

							<CheckboxSetting
								checked={activeProfile.gitContext.includeRecentCommitBodies}
								label={t("prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitBodies")}
								description={t(
									"prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitBodiesDescription",
								)}
								onChange={(checked) => updateGitContextSetting("includeRecentCommitBodies", checked)}
								shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
							/>

							<CheckboxSetting
								checked={activeProfile.gitContext.includeRecentCommitStats}
								label={t("prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitStats")}
								description={t(
									"prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitStatsDescription",
								)}
								onChange={(checked) => updateGitContextSetting("includeRecentCommitStats", checked)}
								shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
							/>

							<CheckboxSetting
								checked={activeProfile.gitContext.includeRecentCommitDiffs}
								label={t("prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitDiffs")}
								description={t(
									"prompts:supportPrompts.commitMessage.gitContext.includeRecentCommitDiffsDescription",
								)}
								onChange={(checked) => updateGitContextSetting("includeRecentCommitDiffs", checked)}
								shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
							/>

							{activeProfile.gitContext.includeRecentCommitDiffs && (
								<div>
									<VSCodeTextField
										type="text"
										value={String(activeProfile.gitContext.recentCommitDiffCount)}
										onInput={(event) =>
											updateNumberSetting(
												"recentCommitDiffCount",
												((event as any).target as HTMLInputElement).value,
												1,
												5,
											)
										}>
										<span>
											{t("prompts:supportPrompts.commitMessage.gitContext.recentCommitDiffCount")}
										</span>
									</VSCodeTextField>
									<div className="text-sm text-vscode-descriptionForeground mt-1">
										{t(
											"prompts:supportPrompts.commitMessage.gitContext.recentCommitDiffCountDescription",
										)}
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Optional attribution footer appended deterministically after generation. */}
			<div className="mt-2 flex flex-col gap-3 pt-2 border-t border-vscode-panel-border">
				<div>
					<div className="font-medium mb-1">
						{t("prompts:supportPrompts.commitMessage.attribution.title")}
					</div>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("prompts:supportPrompts.commitMessage.attribution.description")}
					</div>
				</div>

				<CheckboxSetting
					checked={attributionSettings.enabled}
					label={t("prompts:supportPrompts.commitMessage.attribution.enabled")}
					description={t("prompts:supportPrompts.commitMessage.attribution.enabledDescription")}
					onChange={(checked) => updateAttributionSetting({ enabled: checked })}
					shouldIgnoreChange={() => suppressCheckboxChangesRef.current}
					data-testid="commit-message-attribution-enabled"
				/>

				{attributionSettings.enabled && (
					<div>
						<label className="block font-medium mb-1">
							{t("prompts:supportPrompts.commitMessage.attribution.template")}
						</label>
						<VSCodeTextArea
							resize="vertical"
							value={attributionSettings.template || defaultCommitMessageAttributionSettings.template}
							onInput={(event) => updateAttributionSetting({ template: getTextAreaValue(event) })}
							rows={3}
							className="w-full"
							data-testid="commit-message-attribution-template"
						/>
						<div className="text-sm text-vscode-descriptionForeground mt-1">
							{t("prompts:supportPrompts.commitMessage.attribution.placeholders")}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

interface CheckboxSettingProps {
	checked: boolean
	label: string
	description: string
	onChange: (checked: boolean) => void
	shouldIgnoreChange?: () => boolean
	"data-testid"?: string
}

const CheckboxSetting = ({
	checked,
	label,
	description,
	onChange,
	shouldIgnoreChange,
	"data-testid": dataTestId,
}: CheckboxSettingProps) => (
	<div>
		<VSCodeCheckbox
			checked={checked}
			data-testid={dataTestId}
			onChange={(event) => {
				if (shouldIgnoreChange?.()) {
					return
				}

				onChange((event.target as HTMLInputElement).checked)
			}}>
			<span className="font-medium">{label}</span>
		</VSCodeCheckbox>
		<div className="text-sm text-vscode-descriptionForeground mt-1">{description}</div>
	</div>
)

export default CommitMessagePromptSettings
