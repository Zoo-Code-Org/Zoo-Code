import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@roo-code/types"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	IMAGE_GENERATION: "imageGeneration",
	RUN_SLASH_COMMAND: "runSlashCommand",
	CUSTOM_TOOLS: "customTools",
	PARALLEL_TOOL_EXECUTION: "parallelToolExecution",
} as const satisfies Record<string, ExperimentId>

type _AssertExperimentIds = AssertEqual<Equals<ExperimentId, Values<typeof EXPERIMENT_IDS>>>

type ExperimentKey = Keys<typeof EXPERIMENT_IDS>

interface ExperimentConfig {
	enabled: boolean
	/** Defaults to true; set to false to hide from the Settings panel. */
	showInSettings?: boolean
}

export const experimentConfigsMap: Record<ExperimentKey, ExperimentConfig> = {
	// Chat-diff is the default approval path (plan issue #33, L2): writes are saved
	// without opening/refocusing the diff editor. The diff-editor path remains
	// available by toggling this experiment off (storage key unchanged).
	PREVENT_FOCUS_DISRUPTION: { enabled: true },
	IMAGE_GENERATION: { enabled: false },
	RUN_SLASH_COMMAND: { enabled: false },
	CUSTOM_TOOLS: { enabled: false },
	// TODO: add i18n keys (settings:experimental.PARALLEL_TOOL_EXECUTION.name/.description) in the same PR that sets showInSettings: true
	PARALLEL_TOOL_EXECUTION: { enabled: false, showInSettings: false },
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
