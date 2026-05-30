import {
	DEFAULT_LEARNING_CONFIG,
	EMPTY_LEARNING_STATE,
	type ActionType,
	type Experiments,
	type FeedbackSignal,
	type ImprovementAction,
	type LearnedPattern,
	type LearningConfig,
	type LearningEvent,
	type LearningState,
	type LearningTelemetry,
	type PatternState,
	type PatternType,
	type SelfImprovingScope,
} from "@roo-code/types"

// Re-export shared types for convenience
export type {
	ActionType,
	Experiments,
	FeedbackSignal,
	ImprovementAction,
	LearnedPattern,
	LearningConfig,
	LearningEvent,
	LearningState,
	LearningTelemetry,
	PatternState,
	PatternType,
	SelfImprovingScope,
}

/**
 * Output channel logger interface - abstracts VS Code OutputChannel
 */
export interface Logger {
	appendLine(message: string): void
}

/**
 * Code index adapter contract - read-only view of code index availability
 */
export interface CodeIndexInfo {
	available: boolean
	hits: number
	topScore?: number
}

/**
 * Task lifecycle event adapter - normalizes task events into learning signals
 */
export interface TaskEventInfo {
	taskId: string
	mode?: string
	workspacePath?: string
	success?: boolean
	corrected?: boolean
	toolNames?: string[]
	userTurnCount?: number
	toolIterationCount?: number
	errorKey?: string
	promptFingerprint?: string
}

/**
 * Prompt context result - bounded set of learned guidance for prompt injection
 */
export interface PromptContext {
	entries: Array<{
		type: PatternType
		summary: string
		confidence: number
	}>
	revision: number
}

/**
 * Manager options for construction
 */
export interface SelfImprovingManagerOptions {
	globalStoragePath: string
	logger: Logger
	getExperiments: () => Experiments | undefined
	getMemoryBackend?: () => "builtin" | "agentmemory" | undefined
	getAgentMemoryUrl?: () => string | undefined
	getSelfImprovingScope?: () => SelfImprovingScope | undefined
	getAutoSkillsScope?: () => SelfImprovingScope | undefined
	getWorkspacePath?: () => string | undefined
	/** Memory backend type: "builtin" (default) or "agentmemory" */
	memoryBackend?: "builtin" | "agentmemory"
	/** agentmemory server URL (default: http://localhost:3111) */
	agentMemoryUrl?: string
	/** Optional curator configuration overrides */
	curatorConfig?: {
		intervalMs?: number
		minIdleMs?: number
		firstRunDeferred?: boolean
		staleAfterDays?: number
		archiveAfterDays?: number
		backupsEnabled?: boolean
		maxBackups?: number
	}
	/** Optional SkillsManager reference for skill telemetry integration */
	skillsManager?: {
		getSkillNames(): string[]
		getSkillProvenance(name: string): string
		getSkillProvenanceForSource?(name: string, source: "global" | "project"): string
		hasSkill?(name: string, source: "global" | "project"): boolean
		createSkillFromContent(
			name: string,
			source: "global" | "project",
			description: string,
			content: string,
			modeSlugs?: string[],
		): Promise<string>
		updateSkillContent(name: string, source: "global" | "project", content: string, mode?: string): Promise<void>
	}
}

/**
 * Shared learning defaults re-exported for local convenience.
 */
export const DEFAULT_CONFIG: LearningConfig = DEFAULT_LEARNING_CONFIG

/**
 * Shared empty learning state re-exported for local convenience.
 */
export const EMPTY_STATE: LearningState = EMPTY_LEARNING_STATE

/**
 * A single requirement extracted from a user prompt.
 */
export interface Requirement {
	id: string
	/** The original requirement text extracted from user prompt */
	text: string
	/** Category of requirement */
	category: "functional" | "non-functional" | "constraint" | "goal" | "edge-case" | "security" | "compliance"
	/** Current verification status */
	status: "pending" | "verified" | "failed" | "skipped" | "superseded"
	/** How this requirement was verified */
	verifiedBy?: "code-review" | "test" | "manual" | "build" | "lint" | "type-check"
	/** Evidence that this requirement is fulfilled */
	evidence?: string
	/** Timestamp when verified */
	verifiedAt?: number
	/** Optional linked todo item ID */
	todoId?: string
	/** Index of the user message this requirement was extracted from (0 = first message) */
	messageIndex: number
	/** If superseded, the ID of the requirement that superseded this one */
	supersededBy?: string
	/** If this requirement supersedes another, the ID of the superseded requirement */
	supersedes?: string
}

/**
 * Result of conflict resolution between a new requirement and existing ones.
 */
export interface ConflictResolution {
	/** IDs of existing requirements that are superseded by the new requirement */
	supersedes: string[]
	/** Confidence score 0-1 */
	confidence: number
	/** Explanation of the decision */
	reason: string
}

/**
 * Pluggable conflict resolver that determines if a new requirement supersedes existing ones.
 */
export interface ConflictResolver {
	readonly name: string
	/**
	 * Determine if a new requirement supersedes any existing requirements.
	 * @param newRequirement The newly extracted requirement
	 * @param existingRequirements All currently active (non-superseded) requirements
	 * @param newMessageIndex The index of the message this requirement came from
	 * @param allMessages All user messages in the session (for context)
	 */
	resolve(
		newRequirement: Requirement,
		existingRequirements: Requirement[],
		newMessageIndex: number,
		allMessages: string[],
	): Promise<ConflictResolution>
}

/**
 * Result of running requirements verification.
 */
export interface RequirementsVerificationResult {
	/** All requirements passed */
	passed: boolean
	/** Total requirements extracted */
	total: number
	/** Requirements that passed verification */
	verified: Requirement[]
	/** Requirements that failed verification */
	failed: Requirement[]
	/** Requirements not yet checked */
	pending: Requirement[]
	/** Summary message */
	summary: string
}
