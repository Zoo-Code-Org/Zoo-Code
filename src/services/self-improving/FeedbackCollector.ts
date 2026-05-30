import crypto from "crypto"

import type { CodeIndexInfo, Experiments, FeedbackSignal, LearningEvent, TaskEventInfo } from "./types"

interface FeedbackCollectorOptions {
	getExperiments?: () => Experiments | undefined
}

/**
 * FeedbackCollector - normalizes task/user/tool/code-index signals
 * into structured LearningEvent objects.
 *
 * This is a stateless converter - it creates events from raw signals
 * without side effects. The caller (SelfImprovingManager) owns
 * persistence and lifecycle.
 */
export class FeedbackCollector {
	private readonly getExperiments: () => Experiments | undefined

	constructor(options: FeedbackCollectorOptions = {}) {
		this.getExperiments = options.getExperiments ?? (() => undefined)
	}
	/**
	 * Create a learning event from a task completion signal.
	 */
	createTaskEvent(info: TaskEventInfo): LearningEvent {
		const signal: FeedbackSignal = info.success ? "TASK_SUCCESS" : "TASK_FAILURE"

		return {
			id: crypto.randomUUID(),
			signal,
			timestamp: Date.now(),
			taskId: info.taskId,
			workspacePath: info.workspacePath,
			mode: info.mode,
			context: {
				userTurnCount: info.userTurnCount,
				toolIterationCount: info.toolIterationCount,
				toolNames: info.toolNames,
				promptFingerprint: info.promptFingerprint,
				errorKey: info.errorKey,
			},
			outcome: {
				success: info.success,
				corrected: info.corrected,
				confidenceDelta: info.success ? 0.05 : -0.1,
			},
		}
	}

	/**
	 * Create a learning event from a user correction signal.
	 */
	createCorrectionEvent(info: TaskEventInfo): LearningEvent {
		return {
			id: crypto.randomUUID(),
			signal: "USER_CORRECTION",
			timestamp: Date.now(),
			taskId: info.taskId,
			workspacePath: info.workspacePath,
			mode: info.mode,
			context: {
				toolNames: info.toolNames,
				errorKey: info.errorKey,
				promptFingerprint: info.promptFingerprint,
			},
			outcome: {
				corrected: true,
				confidenceDelta: -0.15,
			},
		}
	}

	/**
	 * Create a learning event from a pattern repeat signal.
	 */
	createPatternRepeatEvent(patternId: string, taskId?: string, mode?: string): LearningEvent {
		return {
			id: crypto.randomUUID(),
			signal: "PATTERN_REPEAT",
			timestamp: Date.now(),
			taskId,
			mode,
			context: {
				promptFingerprint: patternId,
			},
			outcome: {
				confidenceDelta: 0.02,
			},
		}
	}

	/**
	 * Create a learning event from a code index hit.
	 */
	createCodeIndexEvent(codeIndex: CodeIndexInfo, taskId?: string): LearningEvent {
		return {
			id: crypto.randomUUID(),
			signal: "CODE_INDEX_HIT",
			timestamp: Date.now(),
			taskId,
			context: {
				codeIndex: {
					available: codeIndex.available,
					hits: codeIndex.hits,
					topScore: codeIndex.topScore,
				},
			},
			outcome: {
				confidenceDelta: codeIndex.hits > 0 ? 0.03 : 0,
			},
		}
	}

	/**
	 * Create a learning event from a prompt quality signal.
	 */
	createPromptQualityEvent(quality: number, promptFingerprint?: string): LearningEvent {
		return {
			id: crypto.randomUUID(),
			signal: "PROMPT_QUALITY",
			timestamp: Date.now(),
			context: {
				promptFingerprint,
			},
			outcome: {
				confidenceDelta: quality > 0.5 ? 0.01 : -0.01,
			},
		}
	}

	/**
	 * Create a learning event from a tool preference signal.
	 * Gate behind SELF_IMPROVING_TOOL_PREFERENCE experiment flag.
	 */
	createToolPreferenceEvent(toolName: string, successRate: number, taskId?: string): LearningEvent | undefined {
		const experiments = this.getExperiments()
		if (experiments?.selfImprovingToolPreference === false) {
			return undefined
		}

		return {
			id: crypto.randomUUID(),
			signal: "TOOL_PREFERENCE",
			timestamp: Date.now(),
			taskId,
			context: {
				toolNames: [toolName],
			},
			outcome: {
				success: successRate > 0.5,
				confidenceDelta: successRate > 0.5 ? 0.02 : -0.02,
			},
		}
	}
}
