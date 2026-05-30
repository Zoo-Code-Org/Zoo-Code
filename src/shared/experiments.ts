import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@roo-code/types"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	IMAGE_GENERATION: "imageGeneration",
	RUN_SLASH_COMMAND: "runSlashCommand",
	CUSTOM_TOOLS: "customTools",
	SELF_IMPROVING: "selfImproving",
	SELF_IMPROVING_AUTO_SKILLS: "selfImprovingAutoSkills",
	SELF_IMPROVING_AUTO_MODE: "selfImprovingAutoMode",
	SELF_IMPROVING_REVIEW_TEAM: "selfImprovingReviewTeam",
	SELF_IMPROVING_FULL_TRUST: "selfImprovingFullTrust",
	SELF_IMPROVING_QUESTION_EVALUATION: "selfImprovingQuestionEvaluation",
	SELF_IMPROVING_PROMPT_QUALITY: "selfImprovingPromptQuality",
	SELF_IMPROVING_TOOL_PREFERENCE: "selfImprovingToolPreference",
	SELF_IMPROVING_SKILL_MERGE: "selfImprovingSkillMerge",
	SELF_IMPROVING_PERSIST_COUNTS: "selfImprovingPersistCounts",
	SELF_IMPROVING_CODE_INDEX: "selfImprovingCodeIndex",
	ONE_SHOT_ORCHESTRATOR: "oneShotOrchestrator",
	KAIZEN_ORCHESTRATOR: "kaizenOrchestrator",
	PREVENTION_ENGINE: "preventionEngine",
	CASCADE_TRACKER: "cascadeTracker",
	RESILIENCE_SERVICE: "resilienceService",
	TOOL_ERROR_HEALER: "toolErrorHealer",
	VERIFICATION_ENGINE: "verificationEngine",
	REQUIREMENTS_VERIFICATION: "requirementsVerification",
	RECOVERY_CONTEXT: "recoveryContext",
	SELF_IMPROVING_SPECIALIZED_SKILLS: "selfImprovingSpecializedSkills",
} as const satisfies Record<string, ExperimentId>

type ExperimentKey = Keys<typeof EXPERIMENT_IDS>

interface ExperimentConfig {
	enabled: boolean
}

export const experimentConfigsMap: Record<ExperimentKey, ExperimentConfig> = {
	PREVENT_FOCUS_DISRUPTION: { enabled: true },
	IMAGE_GENERATION: { enabled: true },
	RUN_SLASH_COMMAND: { enabled: true },
	CUSTOM_TOOLS: { enabled: true },
	SELF_IMPROVING: { enabled: true },
	SELF_IMPROVING_AUTO_SKILLS: { enabled: true },
	SELF_IMPROVING_AUTO_MODE: { enabled: true },
	SELF_IMPROVING_REVIEW_TEAM: { enabled: true },
	SELF_IMPROVING_FULL_TRUST: { enabled: true },
	SELF_IMPROVING_QUESTION_EVALUATION: { enabled: true },
	SELF_IMPROVING_PROMPT_QUALITY: { enabled: true },
	SELF_IMPROVING_TOOL_PREFERENCE: { enabled: true },
	SELF_IMPROVING_SKILL_MERGE: { enabled: true },
	SELF_IMPROVING_PERSIST_COUNTS: { enabled: true },
	SELF_IMPROVING_CODE_INDEX: { enabled: true },
	ONE_SHOT_ORCHESTRATOR: { enabled: true },
	KAIZEN_ORCHESTRATOR: { enabled: true },
	PREVENTION_ENGINE: { enabled: true },
	CASCADE_TRACKER: { enabled: true },
	RESILIENCE_SERVICE: { enabled: true },
	TOOL_ERROR_HEALER: { enabled: true },
	VERIFICATION_ENGINE: { enabled: true },
	REQUIREMENTS_VERIFICATION: { enabled: true },
	RECOVERY_CONTEXT: { enabled: true },
	SELF_IMPROVING_SPECIALIZED_SKILLS: { enabled: true },
}

export const experimentDefault = Object.fromEntries(
	Object.entries(experimentConfigsMap).map(([_, config]) => [
		EXPERIMENT_IDS[_ as keyof typeof EXPERIMENT_IDS] as ExperimentId,
		config.enabled,
	]),
) as Record<ExperimentId, boolean>

export const experiments = {
	get: (id: ExperimentKey): ExperimentConfig | undefined => experimentConfigsMap[id],
	isEnabled: (experimentsConfig: Experiments, id: ExperimentId) => experimentsConfig[id] ?? experimentDefault[id],
} as const
