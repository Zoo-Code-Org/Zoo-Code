/**
 * Self-Improving Module
 *
 * A standalone, experiment-gated subsystem that learns from task outcomes
 * to improve prompt guidance, tool preferences, and error avoidance over time.
 *
 * Architecture: Hermes-agent symbolic learning loop adapted to Zoo-Code patterns.
 * See ARCHITECTURE.md for full design documentation.
 */

export { SelfImprovingManager } from "./SelfImprovingManager"
export { LearningStore } from "./LearningStore"
export { FeedbackCollector } from "./FeedbackCollector"
export { PatternAnalyzer } from "./PatternAnalyzer"
export { ImprovementApplier } from "./ImprovementApplier"
export { CodeIndexAdapter } from "./CodeIndexAdapter"
export { MemoryBackendFactory } from "./MemoryBackendFactory"
export { AgentMemoryAdapter } from "./AgentMemoryAdapter"
export { MemoryStore } from "./MemoryStore"
export { SkillUsageStore } from "./SkillUsageStore"
export { ActionExecutor } from "./ActionExecutor"
export { CuratorService } from "./CuratorService"
export { ReviewPromptFactory } from "./ReviewPromptFactory"
export { TranscriptRecall } from "./TranscriptRecall"
export { InsightsEngine } from "./InsightsEngine"
export { AutoModeOrchestrator } from "./AutoModeOrchestrator"
export type { AutoModeConfig } from "./AutoModeOrchestrator"
export { ModeFactoryService } from "./ModeFactoryService"
export { VerificationEngine } from "./VerificationEngine"
export type { VerificationResult, VerificationConfig } from "./VerificationEngine"
export { RequirementsVerifier } from "./RequirementsVerifier"
export type { RequirementsVerifierConfig } from "./RequirementsVerifier"
export { KeywordConflictResolver } from "./KeywordConflictResolver"
export { LLMConflictResolver } from "./LLMConflictResolver"
export { AccumulatedScoreStore } from "./AccumulatedScoreStore"
export type { AccumulatedScoreEntry } from "./AccumulatedScoreStore"
export { LLMScorer } from "./LLMScorer"
export type { LLMScoreInput, LLMScoreResult } from "./LLMScorer"

export type { CodeIndexInfo, Logger, PromptContext, SelfImprovingManagerOptions, TaskEventInfo, Requirement, RequirementsVerificationResult, ConflictResolver, ConflictResolution } from "./types"
export type { MemoryBackend, MemoryBackendType } from "./MemoryBackend"
export type { MemoryStoreType } from "./MemoryStore"
export type { SkillTelemetryRecord, SkillProvenance, SkillLifecycleState } from "./SkillUsageStore"
export type { CuratorConfig, CuratorReport } from "./CuratorService"
export type { ReviewType, ReviewPrompt } from "./ReviewPromptFactory"
export type { TranscriptEntry } from "./TranscriptRecall"
export type { InsightsReport } from "./InsightsEngine"

export { DEFAULT_CONFIG, EMPTY_STATE } from "./types"

export { ErrorClassifier, ErrorCategory } from "./ErrorClassifier"
export type { ClassifiedError } from "./ErrorClassifier"
export { ToolCallValidator } from "./ToolCallValidator"
export type { ValidationResult } from "./ToolCallValidator"
export { CascadeTracker } from "./CascadeTracker"
export { PreventionEngine } from "./PreventionEngine"
export type { PreventionContext } from "./PreventionEngine"
