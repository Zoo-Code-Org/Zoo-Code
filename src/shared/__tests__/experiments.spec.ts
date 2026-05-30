// npx vitest run src/shared/__tests__/experiments.spec.ts

import { EXPERIMENT_IDS, experimentConfigsMap, experiments } from "../experiments"

describe("experiments", () => {
	describe("PREVENT_FOCUS_DISRUPTION", () => {
		it("is configured correctly", () => {
			expect(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION).toBe("preventFocusDisruption")
			expect(experimentConfigsMap.PREVENT_FOCUS_DISRUPTION).toMatchObject({
				enabled: true,
			})
		})
	})

	describe("SELF_IMPROVING", () => {
		it("is configured correctly", () => {
			expect(EXPERIMENT_IDS.SELF_IMPROVING).toBe("selfImproving")
			expect(experimentConfigsMap.SELF_IMPROVING).toMatchObject({
				enabled: true,
			})
		})
	})

	describe("SELF_IMPROVING_AUTO_SKILLS", () => {
		it("is configured correctly", () => {
			expect(EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS).toBe("selfImprovingAutoSkills")
			expect(experimentConfigsMap.SELF_IMPROVING_AUTO_SKILLS).toMatchObject({
				enabled: true,
			})
		})
	})

	describe("isEnabled", () => {
		it("returns false when experiment is not enabled", () => {
			const config = {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				selfImproving: false,
				selfImprovingAutoSkills: false,
				selfImprovingAutoMode: false,
				selfImprovingReviewTeam: false,
				selfImprovingFullTrust: false,
				selfImprovingQuestionEvaluation: false,
				selfImprovingPromptQuality: false,
				selfImprovingToolPreference: false,
				selfImprovingSkillMerge: false,
				selfImprovingPersistCounts: false,
				selfImprovingCodeIndex: false,
				verificationEngine: false,
				requirementsVerification: false,
				oneShotOrchestrator: false,
				kaizenOrchestrator: false,
				preventionEngine: false,
				cascadeTracker: false,
				resilienceService: false,
				toolErrorHealer: false,
				recoveryContext: false,
				selfImprovingSpecializedSkills: false,
			}
			expect(experiments.isEnabled(config, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)
		})

		it("returns true when experiment is enabled", () => {
			const config = {
				preventFocusDisruption: true,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				selfImproving: false,
				selfImprovingAutoSkills: false,
				selfImprovingAutoMode: false,
				selfImprovingReviewTeam: false,
				selfImprovingFullTrust: false,
				selfImprovingQuestionEvaluation: false,
				selfImprovingPromptQuality: false,
				selfImprovingToolPreference: false,
				selfImprovingSkillMerge: false,
				selfImprovingPersistCounts: false,
				selfImprovingCodeIndex: false,
				verificationEngine: false,
				requirementsVerification: false,
				oneShotOrchestrator: false,
				kaizenOrchestrator: false,
				preventionEngine: false,
				cascadeTracker: false,
				resilienceService: false,
				toolErrorHealer: false,
				recoveryContext: false,
				selfImprovingSpecializedSkills: false,
			}
			expect(experiments.isEnabled(config, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)
		})

		it("returns false when experiment is not in the map", () => {
			const config = {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				selfImproving: false,
				selfImprovingAutoSkills: false,
				selfImprovingAutoMode: false,
				selfImprovingReviewTeam: false,
				selfImprovingFullTrust: false,
				selfImprovingQuestionEvaluation: false,
				selfImprovingPromptQuality: false,
				selfImprovingToolPreference: false,
				selfImprovingSkillMerge: false,
				selfImprovingPersistCounts: false,
				selfImprovingCodeIndex: false,
				verificationEngine: false,
				requirementsVerification: false,
				oneShotOrchestrator: false,
				kaizenOrchestrator: false,
				preventionEngine: false,
				cascadeTracker: false,
				resilienceService: false,
				toolErrorHealer: false,
				recoveryContext: false,
				selfImprovingSpecializedSkills: false,
			}
			expect(experiments.isEnabled(config, "nonExistentExperiment" as any)).toBeUndefined()
		})
	})
})
