import { HTMLAttributes } from "react"

import type { Experiments, ImageGenerationProvider } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@roo/experiments"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { cn } from "@src/lib/utils"

import { SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { ImageGenerationSettings } from "./ImageGenerationSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"
import { SelfImprovingStatus } from "./SelfImprovingStatus"

type ExperimentalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	apiConfiguration?: any
	setApiConfigurationField?: any
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	memoryBackend?: "builtin" | "agentmemory"
	agentMemoryUrl?: string
	selfImprovingScope?: "workspace" | "global"
	selfImprovingAutoSkillsScope?: "workspace" | "global"
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setImageGenerationSelectedModel?: (model: string) => void
	setMemoryBackend?: (backend: "builtin" | "agentmemory") => void
	setAgentMemoryUrl?: (url: string) => void
	setSelfImprovingScope?: (scope: "workspace" | "global") => void
	setSelfImprovingAutoSkillsScope?: (scope: "workspace" | "global") => void
	setLenientModes?: (modes: string[]) => void
}

export const ExperimentalSettings = ({
	experiments,
	setExperimentEnabled,
	apiConfiguration,
	setApiConfigurationField,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	memoryBackend,
	agentMemoryUrl,
	selfImprovingScope,
	selfImprovingAutoSkillsScope,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setImageGenerationSelectedModel,
	setMemoryBackend,
	setAgentMemoryUrl,
	setSelfImprovingScope,
	setSelfImprovingAutoSkillsScope,
	setLenientModes,
	className,
	...props
}: ExperimentalSettingsProps) => {
	const { t } = useAppTranslation()
	const autoSkillsVisible = experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false
	const autoSkillsEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS] ?? false
	const autoModeEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_AUTO_MODE] ?? false
	const reviewTeamEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_REVIEW_TEAM] ?? false
	const fullTrustEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_FULL_TRUST] ?? false
	const questionEvaluationEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_QUESTION_EVALUATION] ?? false
	const promptQualityEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_PROMPT_QUALITY] ?? false
	const toolPreferenceEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_TOOL_PREFERENCE] ?? false
	const skillMergeEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_SKILL_MERGE] ?? false
	const persistCountsEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_PERSIST_COUNTS] ?? false
	const codeIndexEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_CODE_INDEX] ?? false
	const currentMemoryBackend = memoryBackend ?? "builtin"
	const currentSelfImprovingScope = selfImprovingScope ?? "global"
	const currentAutoSkillsScope = selfImprovingAutoSkillsScope ?? "workspace"

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.experimental")}</SectionHeader>

			<Section>
				{Object.entries(experimentConfigsMap)
					.filter(
						([key]) =>
							key in EXPERIMENT_IDS &&
							key !== "SELF_IMPROVING_AUTO_SKILLS" &&
							key !== "SELF_IMPROVING_AUTO_MODE" &&
							key !== "SELF_IMPROVING_REVIEW_TEAM" &&
							key !== "SELF_IMPROVING_FULL_TRUST" &&
							key !== "SELF_IMPROVING_QUESTION_EVALUATION" &&
							key !== "SELF_IMPROVING_PROMPT_QUALITY" &&
							key !== "SELF_IMPROVING_TOOL_PREFERENCE" &&
							key !== "SELF_IMPROVING_SKILL_MERGE" &&
							key !== "SELF_IMPROVING_PERSIST_COUNTS" &&
							key !== "SELF_IMPROVING_CODE_INDEX" &&
							key !== "ONE_SHOT_ORCHESTRATOR" &&
							key !== "KAIZEN_ORCHESTRATOR" &&
							key !== "PREVENTION_ENGINE" &&
							key !== "CASCADE_TRACKER" &&
							key !== "RESILIENCE_SERVICE" &&
							key !== "TOOL_ERROR_HEALER" &&
							key !== "VERIFICATION_ENGINE" &&
							key !== "REQUIREMENTS_VERIFICATION",
					)
					.map((config) => {
						const experimentKey = config[0]
						const label = t(`settings:experimental.${experimentKey}.name`)

						if (
							config[0] === "IMAGE_GENERATION" &&
							setImageGenerationProvider &&
							setOpenRouterImageApiKey &&
							setImageGenerationSelectedModel
						) {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<ImageGenerationSettings
										enabled={experiments[EXPERIMENT_IDS.IMAGE_GENERATION] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.IMAGE_GENERATION, enabled)
										}
										imageGenerationProvider={imageGenerationProvider}
										openRouterImageApiKey={openRouterImageApiKey}
										openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
										setImageGenerationProvider={setImageGenerationProvider}
										setOpenRouterImageApiKey={setOpenRouterImageApiKey}
										setImageGenerationSelectedModel={setImageGenerationSelectedModel}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "CUSTOM_TOOLS") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<CustomToolsSettings
										enabled={experiments[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)
										}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "SELF_IMPROVING") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<div className="space-y-3">
										<ExperimentalFeature
											experimentKey={config[0]}
											enabled={experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false}
											onChange={(enabled) =>
												setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING, enabled)
											}
											checkboxTestId="experimental-self-improving-checkbox"
										/>
										{autoSkillsVisible && (
											<div className="ml-6 space-y-3 border-l border-vscode-panel-border pl-4">
												{setSelfImprovingScope && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t("settings:experimental.SELF_IMPROVING.scopeLabel", {
																defaultValue: "Self-learning scope",
															})}
														</label>
														<Select
															value={currentSelfImprovingScope}
															onValueChange={(value) =>
																setSelfImprovingScope(value as "workspace" | "global")
															}
															data-testid="self-improving-scope-select">
															<SelectTrigger className="w-full">
																<SelectValue
																	placeholder={t("settings:common.select")}
																/>
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="workspace">
																	{t(
																		"settings:experimental.SELF_IMPROVING.scopeWorkspace",
																		{
																			defaultValue: "Workspace",
																		},
																	)}
																</SelectItem>
																<SelectItem value="global">
																	{t(
																		"settings:experimental.SELF_IMPROVING.scopeGlobal",
																		{
																			defaultValue: "Global",
																		},
																	)}
																</SelectItem>
															</SelectContent>
														</Select>
													</div>
												)}
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_AUTO_SKILLS"
													enabled={autoSkillsEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-auto-skills-checkbox"
												/>
												{autoSkillsEnabled && setSelfImprovingAutoSkillsScope && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t(
																"settings:experimental.SELF_IMPROVING.autoSkillsScopeLabel",
																{
																	defaultValue: "Auto-create/update skills scope",
																},
															)}
														</label>
														<Select
															value={currentAutoSkillsScope}
															onValueChange={(value) =>
																setSelfImprovingAutoSkillsScope(
																	value as "workspace" | "global",
																)
															}
															data-testid="self-improving-auto-skills-scope-select">
															<SelectTrigger className="w-full">
																<SelectValue
																	placeholder={t("settings:common.select")}
																/>
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="workspace">
																	{t(
																		"settings:experimental.SELF_IMPROVING.scopeWorkspace",
																		{
																			defaultValue: "Workspace",
																		},
																	)}
																</SelectItem>
																<SelectItem value="global">
																	{t(
																		"settings:experimental.SELF_IMPROVING.scopeGlobal",
																		{
																			defaultValue: "Global",
																		},
																	)}
																</SelectItem>
															</SelectContent>
														</Select>
													</div>
												)}
												{setMemoryBackend && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t(
																"settings:experimental.SELF_IMPROVING.memoryBackendLabel",
																{
																	defaultValue: "Memory backend",
																},
															)}
														</label>
														<Select
															value={currentMemoryBackend}
															onValueChange={(value) =>
																setMemoryBackend(value as "builtin" | "agentmemory")
															}
															data-testid="self-improving-memory-backend-select">
															<SelectTrigger className="w-full">
																<SelectValue
																	placeholder={t("settings:common.select")}
																/>
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="builtin">
																	{t(
																		"settings:experimental.SELF_IMPROVING.memoryBackendBuiltin",
																		{
																			defaultValue: "Built-in",
																		},
																	)}
																</SelectItem>
																<SelectItem value="agentmemory">agentmemory</SelectItem>
															</SelectContent>
														</Select>
													</div>
												)}
												{currentMemoryBackend === "agentmemory" && setAgentMemoryUrl && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t(
																"settings:experimental.SELF_IMPROVING.agentMemoryUrlLabel",
																{
																	defaultValue: "agentmemory URL",
																},
															)}
														</label>
														<Input
															value={agentMemoryUrl ?? "http://localhost:3111"}
															onChange={(event) => setAgentMemoryUrl(event.target.value)}
															placeholder="http://localhost:3111"
															data-testid="self-improving-agent-memory-url-input"
														/>
													</div>
												)}
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_AUTO_MODE"
													enabled={autoModeEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_AUTO_MODE,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-auto-mode-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_REVIEW_TEAM"
													enabled={reviewTeamEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_REVIEW_TEAM,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-review-team-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_FULL_TRUST"
													enabled={fullTrustEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_FULL_TRUST,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-full-trust-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_QUESTION_EVALUATION"
													enabled={questionEvaluationEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_QUESTION_EVALUATION,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-question-evaluation-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_PROMPT_QUALITY"
													enabled={promptQualityEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_PROMPT_QUALITY,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-prompt-quality-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_TOOL_PREFERENCE"
													enabled={toolPreferenceEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_TOOL_PREFERENCE,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-tool-preference-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_SKILL_MERGE"
													enabled={skillMergeEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_SKILL_MERGE,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-skill-merge-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_PERSIST_COUNTS"
													enabled={persistCountsEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_PERSIST_COUNTS,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-persist-counts-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_CODE_INDEX"
													enabled={codeIndexEnabled}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_CODE_INDEX,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-code-index-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="PREVENTION_ENGINE"
													enabled={
														experiments[EXPERIMENT_IDS.PREVENTION_ENGINE] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.PREVENTION_ENGINE,
															enabled,
														)
													}
													checkboxTestId="experimental-prevention-engine-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="CASCADE_TRACKER"
													enabled={
														experiments[EXPERIMENT_IDS.CASCADE_TRACKER] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.CASCADE_TRACKER,
															enabled,
														)
													}
													checkboxTestId="experimental-cascade-tracker-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="RESILIENCE_SERVICE"
													enabled={
														experiments[EXPERIMENT_IDS.RESILIENCE_SERVICE] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.RESILIENCE_SERVICE,
															enabled,
														)
													}
													checkboxTestId="experimental-resilience-service-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="TOOL_ERROR_HEALER"
													enabled={
														experiments[EXPERIMENT_IDS.TOOL_ERROR_HEALER] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.TOOL_ERROR_HEALER,
															enabled,
														)
													}
													checkboxTestId="experimental-tool-error-healer-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="VERIFICATION_ENGINE"
													enabled={
														experiments[EXPERIMENT_IDS.VERIFICATION_ENGINE] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.VERIFICATION_ENGINE,
															enabled,
														)
													}
													checkboxTestId="experimental-verification-engine-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="REQUIREMENTS_VERIFICATION"
													enabled={
														experiments[EXPERIMENT_IDS.REQUIREMENTS_VERIFICATION] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.REQUIREMENTS_VERIFICATION,
															enabled,
														)
													}
													checkboxTestId="experimental-requirements-verification-checkbox"
												/>
												<SelfImprovingStatus />
												<ExperimentalFeature
													experimentKey="ONE_SHOT_ORCHESTRATOR"
													enabled={
														experiments[EXPERIMENT_IDS.ONE_SHOT_ORCHESTRATOR] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.ONE_SHOT_ORCHESTRATOR,
															enabled,
														)
													}
													checkboxTestId="experimental-one-shot-orchestrator-checkbox"
												/>
												<ExperimentalFeature
													experimentKey="KAIZEN_ORCHESTRATOR"
													enabled={
														experiments[EXPERIMENT_IDS.KAIZEN_ORCHESTRATOR] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.KAIZEN_ORCHESTRATOR,
															enabled,
														)
													}
													checkboxTestId="experimental-kaizen-orchestrator-checkbox"
												/>
											</div>
										)}
									</div>
								</SearchableSetting>
							)
						}
						return (
							<SearchableSetting
								key={config[0]}
								settingId={`experimental-${config[0].toLowerCase()}`}
								section="experimental"
								label={label}>
								<ExperimentalFeature
									experimentKey={config[0]}
									enabled={
										experiments[EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS]] ?? false
									}
									onChange={(enabled) =>
										setExperimentEnabled(
											EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS],
											enabled,
										)
									}
								/>
							</SearchableSetting>
						)
					})}

					{/* Lenient Modes */}
					<SearchableSetting
						settingId="experimental-lenient-modes"
						section="experimental"
						label="Lenient Modes"
						description="Modes that skip code quality verification on completion (comma-separated mode slugs)">
						<Input
							value={(experiments.lenientModes as string[] | undefined)?.join(", ") ?? "research"}
							onChange={(e) => {
								const modes = e.target.value
									.split(",")
									.map((m) => m.trim())
									.filter(Boolean)
								setLenientModes?.(modes)
							}}
							placeholder="research, ask, architect"
							data-testid="experimental-lenient-modes-input"
						/>
					</SearchableSetting>
				</Section>
			</div>
		)
	}
