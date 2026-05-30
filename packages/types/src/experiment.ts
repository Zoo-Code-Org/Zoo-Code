import { z } from "zod"

import type { Keys, Equals, AssertEqual } from "./type-fu.js"

/**
 * ExperimentId
 */

export const experimentIds = [
	"preventFocusDisruption",
	"imageGeneration",
	"runSlashCommand",
	"customTools",
	"selfImproving",
	"selfImprovingAutoSkills",
	"selfImprovingAutoMode",
	"selfImprovingReviewTeam",
	"selfImprovingFullTrust",
	"selfImprovingQuestionEvaluation",
	"selfImprovingPromptQuality",
	"selfImprovingToolPreference",
	"selfImprovingSkillMerge",
	"selfImprovingPersistCounts",
	"selfImprovingCodeIndex",
	"oneShotOrchestrator",
	"kaizenOrchestrator",
	"preventionEngine",
	"cascadeTracker",
	"resilienceService",
	"toolErrorHealer",
	"verificationEngine",
	"requirementsVerification",
	"recoveryContext",
	"selfImprovingSpecializedSkills",
] as const

export const experimentIdsSchema = z.enum(experimentIds)

export type ExperimentId = z.infer<typeof experimentIdsSchema>

/**
 * Experiments
 */

export const experimentsSchema = z.object({
	preventFocusDisruption: z.boolean().optional(),
	imageGeneration: z.boolean().optional(),
	runSlashCommand: z.boolean().optional(),
	customTools: z.boolean().optional(),
	selfImproving: z.boolean().optional(),
	selfImprovingAutoSkills: z.boolean().optional(),
	selfImprovingAutoMode: z.boolean().optional(),
	selfImprovingReviewTeam: z.boolean().optional(),
	selfImprovingFullTrust: z.boolean().optional(),
	selfImprovingQuestionEvaluation: z.boolean().optional(),
	selfImprovingPromptQuality: z.boolean().optional(),
	selfImprovingToolPreference: z.boolean().optional(),
	selfImprovingSkillMerge: z.boolean().optional(),
	selfImprovingPersistCounts: z.boolean().optional(),
	selfImprovingCodeIndex: z.boolean().optional(),
	oneShotOrchestrator: z.boolean().optional(),
	kaizenOrchestrator: z.boolean().optional(),
	preventionEngine: z.boolean().optional(),
	cascadeTracker: z.boolean().optional(),
	resilienceService: z.boolean().optional(),
	toolErrorHealer: z.boolean().optional(),
	verificationEngine: z.boolean().optional(),
	requirementsVerification: z.boolean().optional(),
	recoveryContext: z.boolean().optional(),
	selfImprovingSpecializedSkills: z.boolean().optional(),

	/**
	 * List of mode slugs that should skip code quality verification in AttemptCompletionTool.
	 * Default: ["research"]
	 */
	lenientModes: z.array(z.string()).optional(),
})

export type Experiments = z.infer<typeof experimentsSchema>
