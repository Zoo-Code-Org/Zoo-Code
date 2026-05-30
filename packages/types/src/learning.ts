import { z } from "zod"

/**
 * FeedbackSignal - types of learning observations
 */
export const feedbackSignalSchema = z.enum([
	"USER_CORRECTION",
	"TASK_SUCCESS",
	"TASK_FAILURE",
	"PATTERN_REPEAT",
	"CODE_INDEX_HIT",
	"PROMPT_QUALITY",
	"TOOL_PREFERENCE",
])

export type FeedbackSignal = z.infer<typeof feedbackSignalSchema>

/**
 * LearningConfig - configuration for the learning system
 */
export const learningConfigSchema = z.object({
	enabled: z.boolean().default(false),
	reviewOnTurnCount: z.number().int().min(1).default(5),
	reviewOnToolIterationCount: z.number().int().min(1).default(20),
	reviewOnEveryTurn: z.boolean().default(false),
	maxStoredPatterns: z.number().int().min(1).default(100),
	maxStoredEvents: z.number().int().min(1).default(500),
	maxPromptPatterns: z.number().int().min(1).default(5),
	curatorEnabled: z.boolean().default(true),
	curatorIntervalMs: z.number().int().min(60000).default(3600000),
	staleAfterDays: z.number().int().min(1).default(14),
	archiveAfterDays: z.number().int().min(1).default(60),
	codeIndexCorrelationEnabled: z.boolean().default(true),
})

export type LearningConfig = z.infer<typeof learningConfigSchema>

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
	enabled: true,
	reviewOnTurnCount: 3,
	reviewOnToolIterationCount: 10,
	reviewOnEveryTurn: false,
	maxStoredPatterns: 100,
	maxStoredEvents: 500,
	maxPromptPatterns: 5,
	curatorEnabled: true,
	curatorIntervalMs: 3_600_000,
	staleAfterDays: 14,
	archiveAfterDays: 60,
	codeIndexCorrelationEnabled: true,
}

/**
 * LearningEvent - a single learning observation
 */
export const learningEventSchema = z.object({
	id: z.string(),
	signal: feedbackSignalSchema,
	timestamp: z.number(),
	taskId: z.string().optional(),
	workspacePath: z.string().optional(),
	mode: z.string().optional(),
	context: z.object({
		userTurnCount: z.number().optional(),
		toolIterationCount: z.number().optional(),
		toolNames: z.array(z.string()).optional(),
		promptFingerprint: z.string().optional(),
		errorKey: z.string().optional(),
		codeIndex: z
			.object({
				available: z.boolean(),
				hits: z.number(),
				topScore: z.number().optional(),
			})
			.optional(),
	}),
	outcome: z.object({
		success: z.boolean().optional(),
		corrected: z.boolean().optional(),
		summary: z.string().optional(),
		confidenceDelta: z.number().optional(),
	}),
})

export type LearningEvent = z.infer<typeof learningEventSchema>

/**
 * PatternState - lifecycle state for learned patterns
 */
export const patternStateSchema = z.enum(["active", "stale", "archived"])

export type PatternState = z.infer<typeof patternStateSchema>

/**
 * PatternType - category of learned pattern
 */
export const patternTypeSchema = z.enum(["prompt", "tool", "error", "skill", "code-index"])

export type PatternType = z.infer<typeof patternTypeSchema>

/**
 * LearnedPattern - a pattern extracted from learning events
 */
export const learnedPatternSchema = z.object({
	id: z.string(),
	patternType: patternTypeSchema,
	state: patternStateSchema,
	summary: z.string(),
	confidenceScore: z.number().min(0).max(1),
	frequency: z.number().int().min(0),
	successRate: z.number().min(0).max(1),
	firstSeenAt: z.number(),
	lastSeenAt: z.number(),
	lastAppliedAt: z.number().optional(),
	sourceSignals: z.array(feedbackSignalSchema),
	context: z.object({
		toolNames: z.array(z.string()).optional(),
		errorKeys: z.array(z.string()).optional(),
		modes: z.array(z.string()).optional(),
		workspacePaths: z.array(z.string()).optional(),
		promptFingerprint: z.string().optional(),
	}),
})

export type LearnedPattern = z.infer<typeof learnedPatternSchema>

/**
 * ActionType - types of improvement actions
 */
export const actionTypeSchema = z.enum([
	"PROMPT_ENRICHMENT",
	"TOOL_PREFERENCE",
	"ERROR_AVOIDANCE",
	"SKILL_SUGGESTION",
	"SKILL_CREATE",
	"SKILL_UPDATE",
	"SKILL_MERGE",
	"SKILL_CREATE_FROM_SCRATCH",
])

export type ActionType = z.infer<typeof actionTypeSchema>

/**
 * ImprovementAction - an action to apply based on learned patterns
 */
export const improvementActionSchema = z.object({
	id: z.string(),
	actionType: actionTypeSchema,
	target: z.enum(["system-prompt", "task-execution", "skills-manager", "review-queue"]),
	payload: z.record(z.string(), z.unknown()),
	timestamp: z.number(),
})

export type ImprovementAction = z.infer<typeof improvementActionSchema>

/**
 * LearningTelemetry - telemetry counters for the learning system
 */
export const learningTelemetrySchema = z.object({
	promptEnrichmentUses: z.number().int().default(0),
	toolPreferenceUses: z.number().int().default(0),
	errorAvoidanceUses: z.number().int().default(0),
	skillSuggestionCount: z.number().int().default(0),
	lastReviewAt: z.number().optional(),
	lastCuratorRunAt: z.number().optional(),
})

export type LearningTelemetry = z.infer<typeof learningTelemetrySchema>

/**
 * LearningState - full serializable state of the learning system
 */
export const learningStateSchema = z.object({
	version: z.literal(1),
	config: learningConfigSchema,
	counters: z.object({
		userTurnsSinceReview: z.number().int().default(0),
		toolIterationsSinceReview: z.number().int().default(0),
	}),
	patterns: z.array(learnedPatternSchema).default([]),
	archivedPatterns: z.array(learnedPatternSchema).default([]),
	recentEvents: z.array(learningEventSchema).default([]),
	pendingActions: z.array(improvementActionSchema).default([]),
	telemetry: learningTelemetrySchema,
})

export type LearningState = z.infer<typeof learningStateSchema>

export const EMPTY_LEARNING_STATE: LearningState = {
	version: 1,
	config: DEFAULT_LEARNING_CONFIG,
	counters: {
		userTurnsSinceReview: 0,
		toolIterationsSinceReview: 0,
	},
	patterns: [],
	archivedPatterns: [],
	recentEvents: [],
	pendingActions: [],
	telemetry: {
		promptEnrichmentUses: 0,
		toolPreferenceUses: 0,
		errorAvoidanceUses: 0,
		skillSuggestionCount: 0,
	},
}
