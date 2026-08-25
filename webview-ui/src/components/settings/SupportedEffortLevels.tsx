import { Checkbox } from "vscrui"
import type { ProviderSettings, ReasoningEffortExtended } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

/**
 * F7 (webview): per-profile declaration of the reasoning effort levels the
 * selected model supports.
 *
 * Self-hosted / OpenAI-compatible endpoints do not advertise
 * `supportsReasoningEffort` in the model registry, so the dynamic thinking
 * effort feature has no capability to work from. This control lets the user
 * declare the canonical levels the model accepts; the extension
 * (`withDeclaredReasoningEffort`) and the webview mirror
 * (`resolveReasoningEffortCapability`) fill the gap only where the model info
 * has no capability of its own, and the per-request effort envelope is sent
 * once a non-empty declaration exists and "Enable Reasoning Effort" is on.
 *
 * Bound through `setApiConfigurationField` like every other provider field, so
 * the value buffers in `cachedState` and persists on Save via the
 * `updateSettings` payload (Persisted Setting Checklist).
 */
const EFFORT_LEVELS: ReasoningEffortExtended[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

type SupportedEffortLevelsProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

export const SupportedEffortLevels = ({ apiConfiguration, setApiConfigurationField }: SupportedEffortLevelsProps) => {
	const { t } = useAppTranslation()
	const declared = apiConfiguration.supportedReasoningEfforts ?? []

	const handleToggle = (level: ReasoningEffortExtended) => {
		const next = declared.includes(level) ? declared.filter((value) => value !== level) : [...declared, level]
		// Keep the canonical level order regardless of toggle order.
		const ordered = EFFORT_LEVELS.filter((value) => next.includes(value))
		setApiConfigurationField("supportedReasoningEfforts", ordered)
		// An empty declaration makes the fill-in a no-op, which would silently
		// disable the per-request effort envelope while the "Enable Reasoning
		// Effort" checkbox still claims it is on — mirror the off-switch so UI
		// and wire state stay in sync.
		if (ordered.length === 0 && apiConfiguration.enableReasoningEffort) {
			setApiConfigurationField("enableReasoningEffort", false)
		}
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="text-sm">{t("settings:providers.supportedEffortLevels.label")}</div>
			<div className="text-xs text-vscode-descriptionForeground whitespace-pre-line">
				{t("settings:providers.supportedEffortLevels.description")}
			</div>
			<div className="flex flex-col gap-0.5">
				{EFFORT_LEVELS.map((level) => (
					<Checkbox key={level} checked={declared.includes(level)} onChange={() => handleToggle(level)}>
						{t(`settings:providers.reasoningEffort.${level}`)}
					</Checkbox>
				))}
			</div>
		</div>
	)
}
